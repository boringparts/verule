use std::{collections::BTreeMap, rc::Rc};

use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::Value;
use tsrs_ast::{Kind, Node, SourceFile, Symbol, SymbolFlags, get_source_file_of_node};
use tsrs_checker::TypeFormatFlags;
use tsrs_compiler::{CheckerHandle, Program};
use tsrs_core::{P, tspath};
use verule_adapter_api::{
    DeclarationInfo, HostAccess, HostValue, NativeAdapterOutput, NativeFactRequest, NativeLibrary,
    NodeKind, NodeOperation, SourceLocation,
};

use crate::calls_values::{
    canonical_symbol_for_node, node_location_rel, node_text, unwrap_expr_wrappers,
};
use crate::observe::{EngineStepDetail, ObserveCollector};
use crate::projection::{safe_expression, safe_initializer};
use crate::projects::{is_project_source_file, relative_to_cwd, resolve_against_cwd};
use crate::serve::{HandlePayload, RpcErr, SnapshotState};

pub type NativeAdapterRegistry = BTreeMap<String, Rc<NativeLibrary>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAdapterPackageInput {
    package_name: String,
    library_path: String,
}

pub fn load_configured_adapters(
    inputs: &[NativeAdapterPackageInput],
) -> Result<NativeAdapterRegistry, RpcErr> {
    let mut adapters = BTreeMap::new();
    for input in inputs {
        let library = NativeLibrary::load(&input.package_name, &input.library_path)
            .map_err(|error| RpcErr::new("NATIVE_ADAPTER_LOAD", error.to_string()))?;
        let id = library.manifest().id.clone();
        if let Some(existing) = adapters.get(&id) {
            let existing: &Rc<NativeLibrary> = existing;
            return Err(RpcErr::new(
                "NATIVE_ADAPTER_LOAD",
                format!(
                    "Adapter package \"{}\" duplicates provider id \"{}\" already loaded from \"{}\".",
                    input.package_name,
                    id,
                    existing.package_name()
                ),
            ));
        }
        adapters.insert(id, Rc::new(library));
    }
    Ok(adapters)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Connects the native provider request to one engine snapshot and its observer."
)]
pub fn extract(
    snapshot: &mut SnapshotState,
    project_id: &str,
    program: &'static Program,
    checker: &mut CheckerHandle,
    provider_id: &str,
    report_provider_id: Option<&str>,
    fact_type_id: &str,
    target_handles: &[String],
    has_targets: bool,
    condition: Option<&Value>,
    step_start: Option<std::time::Instant>,
    observer: &mut ObserveCollector,
) -> Result<NativeAdapterOutput, RpcErr> {
    let adapter = snapshot
        .native_adapters
        .get(provider_id)
        .cloned()
        .ok_or_else(|| {
            RpcErr::new(
                "UNKNOWN_ENGINE_PROVIDER",
                format!("No configured native adapter provides provider id \"{provider_id}\"."),
            )
        })?;
    let targets = resolve_targets(snapshot, project_id, target_handles, has_targets)?;
    let candidates = collect_native_adapter_nodes(&snapshot.cwd, program, checker);
    let candidate_nodes = candidates;
    let calls = candidate_nodes.calls;
    let variables = candidate_nodes.variables;
    let mut table = NodeTable::default();
    let call_ids = table.list(calls.iter().copied());
    let variable_ids = table.list(variables.iter().copied());
    let target_ids = targets
        .as_ref()
        .map(|nodes| table.list(nodes.iter().copied()));
    let mut host = SnapshotAdapterHost {
        cwd: snapshot.cwd.clone(),
        project_id,
        program,
        checker,
        snapshot,
        table,
    };
    let request = NativeFactRequest {
        fact_type_id,
        provider_id,
        project_id,
        condition,
        calls: &call_ids,
        variables: &variable_ids,
        targets: target_ids.as_deref(),
    };
    let output = adapter
        .extract(&request, &mut host)
        .map_err(|error| RpcErr::new("NATIVE_ADAPTER_EXTRACT", error.to_string()))?;
    drop(host);
    let details = if observer.is_detail() {
        output
            .contributions
            .iter()
            .map(|contribution| EngineStepDetail {
                kind: "nativeAdapterFact",
                file: contribution
                    .subject_location
                    .as_ref()
                    .map(|location| location.file.clone()),
                line: contribution
                    .subject_location
                    .as_ref()
                    .map(|location| location.line),
                column: contribution
                    .subject_location
                    .as_ref()
                    .map(|location| location.column),
                summary: format!("{fact_type_id} from {}", adapter.manifest().id),
            })
            .collect()
    } else {
        Vec::new()
    };
    observer.record_provider_step(
        "extractFacts",
        report_provider_id.unwrap_or(&adapter.manifest().id),
        provider_id,
        step_start,
        output.contributions.len(),
        details,
    );
    Ok(output)
}

struct NativeAdapterCandidates {
    calls: Vec<P<Node>>,
    variables: Vec<P<Node>>,
}

/// Collect syntax candidates for native adapters, including nearby workspace declarations reached from imports and calls.
fn collect_native_adapter_nodes(
    cwd: &str,
    program: &'static Program,
    checker: &mut CheckerHandle,
) -> NativeAdapterCandidates {
    let project_files: Vec<P<SourceFile>> = program
        .get_source_files()
        .iter()
        .copied()
        .filter(|&source_file| is_project_source_file(program, source_file))
        .collect();

    let mut calls = Vec::new();
    let mut variables = Vec::new();
    let mut imports = Vec::new();
    for &source_file in &project_files {
        collect_file_syntax(source_file, &mut calls, &mut variables, &mut imports);
    }

    let extra_files = discover_workspace_files(cwd, checker, &project_files, &calls, &imports);
    for source_file in extra_files {
        let mut unused_imports = Vec::new();
        collect_file_syntax(source_file, &mut calls, &mut variables, &mut unused_imports);
    }

    NativeAdapterCandidates { calls, variables }
}

fn collect_file_syntax(
    source_file: P<SourceFile>,
    calls: &mut Vec<P<Node>>,
    variables: &mut Vec<P<Node>>,
    imports: &mut Vec<P<Node>>,
) {
    fn walk(
        node: P<Node>,
        calls: &mut Vec<P<Node>>,
        variables: &mut Vec<P<Node>>,
        imports: &mut Vec<P<Node>>,
    ) {
        match node.kind() {
            Kind::CallExpression => calls.push(node),
            Kind::VariableDeclaration => variables.push(node),
            Kind::ImportSpecifier => imports.push(node),
            _ => {}
        }
        node.for_each_child(&mut |child| {
            walk(child, calls, variables, imports);
            false
        });
    }

    walk(source_file.as_node(), calls, variables, imports);
}

fn discover_workspace_files(
    cwd: &str,
    checker: &mut CheckerHandle,
    project_files: &[P<SourceFile>],
    initial_calls: &[P<Node>],
    initial_imports: &[P<Node>],
) -> Vec<P<SourceFile>> {
    let mut visited_files: FxHashSet<String> = project_files
        .iter()
        .map(|source_file| relative_to_cwd(cwd, source_file.file_name()))
        .collect();
    let mut discovered_files = Vec::new();
    let mut frontier_calls = initial_calls.to_vec();
    let mut frontier_imports = initial_imports.to_vec();

    // Follow workspace entrypoints only two hops so adapters can inspect package sources without walking dependencies.
    for _ in 0..2 {
        let mut references = Vec::with_capacity(frontier_imports.len() + frontier_calls.len() * 3);
        references.extend(frontier_imports.iter().copied());
        for &call in &frontier_calls {
            if let Some(expression) = safe_expression(call) {
                references.push(expression);
                if let Some(inner_expression) = safe_expression(expression) {
                    references.push(inner_expression);
                }
            }
            references.extend(call.arguments().iter().copied());
        }
        if references.is_empty() {
            break;
        }

        let mut next_files = Vec::new();
        for node in references {
            let Some((_, declaration)) = resolve_decl_for_ref(cwd, checker, node) else {
                continue;
            };
            let Some(source_file) = get_source_file_of_node(declaration) else {
                continue;
            };
            let relative_path = relative_to_cwd(cwd, source_file.file_name());
            if is_declaration_file(&relative_path) || is_node_modules_file(&relative_path) {
                continue;
            }
            if visited_files.insert(relative_path) {
                discovered_files.push(source_file);
                next_files.push(source_file);
            }
        }
        if next_files.is_empty() {
            break;
        }

        frontier_calls.clear();
        frontier_imports.clear();
        for source_file in next_files {
            let mut unused_variables = Vec::new();
            collect_file_syntax(
                source_file,
                &mut frontier_calls,
                &mut unused_variables,
                &mut frontier_imports,
            );
        }
    }

    discovered_files
}

fn is_declaration_file(path: &str) -> bool {
    tspath::is_declaration_file_name(path)
}

fn is_node_modules_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with("node_modules/") || normalized.contains("/node_modules/")
}

fn can_follow_declaration(cwd: &str, declaration: P<Node>) -> bool {
    let Some(source_file) = get_source_file_of_node(declaration) else {
        return false;
    };
    if source_file.is_declaration_file() {
        return false;
    }
    let relative_path = relative_to_cwd(cwd, source_file.file_name());
    !is_declaration_file(&relative_path) && !is_node_modules_file(&relative_path)
}

fn resolve_decl_for_ref(
    cwd: &str,
    checker: &mut CheckerHandle,
    node: P<Node>,
) -> Option<(Option<String>, P<Node>)> {
    if matches!(node.kind(), Kind::CallExpression | Kind::NewExpression) {
        let signature = checker.get_resolved_signature_exported(node);
        let signature_declaration = (signature != checker.get_unknown_signature())
            .then(|| {
                signature
                    .declaration()
                    .or_else(|| signature.target().and_then(|target| target.declaration()))
            })
            .flatten();
        let callee_symbol = node
            .expression()
            .and_then(|expression| checker.get_symbol_at_location_exported(expression))
            .map(|symbol| unwrap_alias(checker, symbol))
            .filter(|&symbol| symbol != checker.get_unknown_symbol());
        let primary = signature_declaration.or_else(|| {
            callee_symbol.and_then(|symbol| {
                symbol
                    .value_declaration()
                    .or_else(|| symbol.declarations().first().copied())
            })
        })?;
        let name = callee_symbol.map(|symbol| symbol.name().to_string());
        return can_follow_declaration(cwd, primary).then_some((name, primary));
    }

    let symbol = canonical_symbol_for_node(checker, node)?;
    let primary = symbol
        .value_declaration()
        .or_else(|| symbol.declarations().first().copied())?;
    let name = Some(symbol.name().to_string());
    can_follow_declaration(cwd, primary).then_some((name, primary))
}

fn unwrap_alias(checker: &mut CheckerHandle, mut symbol: P<Symbol>) -> P<Symbol> {
    let mut seen = Vec::new();
    while symbol.flags().intersects(SymbolFlags::Alias) && !seen.contains(&symbol) {
        seen.push(symbol);
        let next = checker.get_aliased_symbol(symbol);
        if next == symbol || next == checker.get_unknown_symbol() {
            break;
        }
        symbol = next;
    }
    symbol
}

fn resolve_targets(
    snapshot: &SnapshotState,
    project_id: &str,
    target_handles: &[String],
    has_targets: bool,
) -> Result<Option<Vec<P<Node>>>, RpcErr> {
    if !has_targets {
        return Ok(None);
    }
    let mut nodes = Vec::with_capacity(target_handles.len());
    for handle_id in target_handles {
        let entry = snapshot.get_entry(project_id, handle_id)?;
        let (HandlePayload::Syntax(node)
        | HandlePayload::Call(node)
        | HandlePayload::Declaration { node, .. }) = entry.payload
        else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!(
                    "Program reference {handle_id} cannot be used as a native adapter fact target."
                ),
            ));
        };
        nodes.push(node);
    }
    Ok(Some(nodes))
}

#[derive(Default)]
struct NodeTable {
    nodes: Vec<P<Node>>,
    ids: FxHashMap<P<Node>, u64>,
}

impl NodeTable {
    fn handle(&mut self, node: P<Node>) -> u64 {
        if let Some(id) = self.ids.get(&node) {
            return *id;
        }
        self.nodes.push(node);
        let id = self.nodes.len() as u64;
        self.ids.insert(node, id);
        id
    }

    fn list(&mut self, nodes: impl IntoIterator<Item = P<Node>>) -> Vec<u64> {
        nodes.into_iter().map(|node| self.handle(node)).collect()
    }

    fn get(&self, id: u64) -> Option<P<Node>> {
        id.checked_sub(1)
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| self.nodes.get(index))
            .copied()
    }
}

struct SnapshotAdapterHost<'a> {
    cwd: String,
    project_id: &'a str,
    program: &'static Program,
    checker: &'a mut CheckerHandle,
    snapshot: &'a mut SnapshotState,
    table: NodeTable,
}

impl HostAccess for SnapshotAdapterHost<'_> {
    fn read_node(&mut self, node_id: u64, operation: NodeOperation) -> Result<HostValue, String> {
        let node = self
            .table
            .get(node_id)
            .ok_or_else(|| format!("unknown syntax handle {node_id}"))?;
        let value = match operation {
            NodeOperation::Kind => HostValue::Kind(map_node_kind(node.kind())),
            NodeOperation::KindLabel => HostValue::Text(Some(format!("{:?}", node.kind()))),
            NodeOperation::Name => {
                HostValue::Node(node.name().map(|child| self.table.handle(child)))
            }
            NodeOperation::Expression => {
                HostValue::Node(node.expression().map(|child| self.table.handle(child)))
            }
            NodeOperation::Body => {
                HostValue::Node(node.body().map(|child| self.table.handle(child)))
            }
            NodeOperation::Initializer => {
                HostValue::Node(node.initializer().map(|child| self.table.handle(child)))
            }
            NodeOperation::SafeInitializer => {
                HostValue::Node(safe_initializer(node).map(|child| self.table.handle(child)))
            }
            NodeOperation::UnwrapExpression => {
                HostValue::Node(Some(self.table.handle(unwrap_expr_wrappers(node))))
            }
            NodeOperation::Text => HostValue::Text(node_text(node)),
            NodeOperation::TypeText => {
                let ty = self.checker.get_type_at_location(node);
                HostValue::Text(Some(self.checker.type_to_string_ex_exported(
                    ty,
                    Some(node),
                    TypeFormatFlags::None,
                    None,
                )))
            }
            NodeOperation::Location => {
                HostValue::Location(node_location_rel(&self.cwd, node).map(to_api_location))
            }
            NodeOperation::Declaration => {
                let declaration = resolve_decl_for_ref(&self.cwd, self.checker, node).map(
                    |(name, declaration)| {
                        let source_file = get_source_file_of_node(declaration);
                        DeclarationInfo {
                            name,
                            kind: Some(format!("{:?}", declaration.kind())),
                            location: node_location_rel(&self.cwd, declaration)
                                .map(to_api_location),
                            syntax: Some(self.table.handle(declaration)),
                            is_external: source_file.is_some_and(|file| {
                                file.is_declaration_file()
                                    || !crate::projects::is_project_source_file(self.program, file)
                            }),
                        }
                    },
                );
                HostValue::Declaration(declaration)
            }
            NodeOperation::DeclarationNode => {
                let declaration = resolve_decl_for_ref(&self.cwd, self.checker, node)
                    .map(|(_, declaration)| declaration);
                HostValue::Node(declaration.map(|declaration| self.table.handle(declaration)))
            }
            NodeOperation::Arguments => {
                let children = if matches!(node.kind(), Kind::CallExpression | Kind::NewExpression)
                {
                    node.arguments()
                        .iter()
                        .map(|child| self.table.handle(*child))
                        .collect()
                } else {
                    Vec::new()
                };
                HostValue::Nodes(children)
            }
            NodeOperation::Properties => {
                let children = if node.kind() == Kind::ObjectLiteralExpression {
                    node.as_object_literal_expression()
                        .properties()
                        .nodes()
                        .iter()
                        .map(|child| self.table.handle(*child))
                        .collect()
                } else {
                    Vec::new()
                };
                HostValue::Nodes(children)
            }
            NodeOperation::Children => {
                let mut children = Vec::new();
                node.for_each_child(&mut |child| {
                    children.push(self.table.handle(child));
                    false
                });
                HostValue::Nodes(children)
            }
            NodeOperation::ProgramReference => {
                HostValue::Text(Some(self.snapshot.alloc_syntax(self.project_id, node)))
            }
        };
        Ok(value)
    }

    fn read_additional_input(&mut self, path: &str) -> Result<String, String> {
        let resolved = resolve_against_cwd(&self.cwd, path);
        std::fs::read_to_string(&resolved).map_err(|error| {
            format!("failed to read adapter input \"{path}\" from \"{resolved}\": {error}")
        })
    }

    fn register_additional_input(&mut self, path: &str) -> Result<(), String> {
        if path.trim().is_empty() {
            return Err("additional input path must not be empty".to_string());
        }
        Ok(())
    }
}

fn to_api_location(location: crate::projection::SourceLocation) -> SourceLocation {
    SourceLocation {
        file: location.file,
        line: location.line,
        column: location.column,
        end_line: location.end_line,
        end_column: location.end_column,
        start: location.start,
        end: location.end,
    }
}

const fn map_node_kind(kind: Kind) -> NodeKind {
    match kind {
        Kind::ArrowFunction => NodeKind::ArrowFunction,
        Kind::Block => NodeKind::Block,
        Kind::CallExpression => NodeKind::CallExpression,
        Kind::ComputedPropertyName => NodeKind::ComputedPropertyName,
        Kind::FunctionExpression => NodeKind::FunctionExpression,
        Kind::Identifier => NodeKind::Identifier,
        Kind::ImportSpecifier => NodeKind::ImportSpecifier,
        Kind::NewExpression => NodeKind::NewExpression,
        Kind::NoSubstitutionTemplateLiteral => NodeKind::NoSubstitutionTemplateLiteral,
        Kind::NumericLiteral => NodeKind::NumericLiteral,
        Kind::ObjectLiteralExpression => NodeKind::ObjectLiteralExpression,
        Kind::PropertyAccessExpression => NodeKind::PropertyAccessExpression,
        Kind::PropertyAssignment => NodeKind::PropertyAssignment,
        Kind::ReturnStatement => NodeKind::ReturnStatement,
        Kind::ShorthandPropertyAssignment => NodeKind::ShorthandPropertyAssignment,
        Kind::SpreadAssignment => NodeKind::SpreadAssignment,
        Kind::StringLiteral => NodeKind::StringLiteral,
        Kind::UndefinedKeyword => NodeKind::UndefinedKeyword,
        Kind::VariableDeclaration => NodeKind::VariableDeclaration,
        Kind::ArrayLiteralExpression => NodeKind::ArrayLiteralExpression,
        Kind::ElementAccessExpression => NodeKind::ElementAccessExpression,
        Kind::TrueKeyword => NodeKind::TrueKeyword,
        Kind::FalseKeyword => NodeKind::FalseKeyword,
        Kind::NullKeyword => NodeKind::NullKeyword,
        Kind::PropertyDeclaration => NodeKind::PropertyDeclaration,
        Kind::FunctionDeclaration => NodeKind::FunctionDeclaration,
        Kind::Parameter => NodeKind::Parameter,
        Kind::BindingElement => NodeKind::BindingElement,
        Kind::AsExpression => NodeKind::AsExpression,
        Kind::NonNullExpression => NodeKind::NonNullExpression,
        Kind::ParenthesizedExpression => NodeKind::ParenthesizedExpression,
        Kind::SatisfiesExpression => NodeKind::SatisfiesExpression,
        Kind::BinaryExpression => NodeKind::BinaryExpression,
        Kind::ConditionalExpression => NodeKind::ConditionalExpression,
        Kind::PrefixUnaryExpression => NodeKind::PrefixUnaryExpression,
        Kind::TemplateExpression => NodeKind::TemplateExpression,
        Kind::TemplateHead => NodeKind::TemplateHead,
        Kind::TemplateSpan => NodeKind::TemplateSpan,
        _ => NodeKind::Other,
    }
}
