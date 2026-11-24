use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicUsize, Ordering},
};

use serde_json::{Value, json};
use verule_adapter_api::{
    ADAPTER_ABI_VERSION, Adapter, AdapterError, AdapterManifest, Context, Evidence,
    FactContribution, FactQuery, FactRequest, Gap, NodeKind, NodeRef,
};

// Acceptance checks use this state to verify that snapshot updates reuse the loaded library.
static INVOCATIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct ComplementFixtureAdapter;

impl Adapter for ComplementFixtureAdapter {
    fn manifest(&self) -> AdapterManifest {
        AdapterManifest {
            abi_version: ADAPTER_ABI_VERSION,
            id: "third-party-fixture-complement".to_string(),
            version: "1.0.0".to_string(),
            fact_type_ids: vec![
                "fixture.call-source".to_string(),
                "fixture.derived-consumer".to_string(),
            ],
        }
    }

    fn extract<'a>(
        &self,
        context: &'a Context<'_>,
        request: &FactRequest<'a>,
    ) -> Result<Vec<FactContribution<'a>>, AdapterError> {
        match request.fact_type_id {
            "fixture.call-source" => extract_call_source(context, request),
            "fixture.derived-consumer" => extract_derived_consumer(context, request),
            other => Err(AdapterError::UnsupportedFactType {
                adapter_id: "third-party-fixture-complement".to_string(),
                fact_type_id: other.to_string(),
            }),
        }
    }
}

fn extract_call_source<'a>(
    context: &'a Context<'_>,
    request: &FactRequest<'a>,
) -> Result<Vec<FactContribution<'a>>, AdapterError> {
    let invocation = INVOCATIONS.fetch_add(1, Ordering::Relaxed) + 1;
    let supplemental_input = context.read_additional_input("fixture.inputs.json")?;
    let annotation_input = serde_json::from_str::<String>(&supplemental_input)
        .unwrap_or_else(|_| supplemental_input.clone());
    let mode = request
        .condition
        .as_ref()
        .and_then(|condition| condition.get("mode"))
        .and_then(Value::as_str);
    let conflict = mode == Some("conflict");
    let targeted_conflict = mode == Some("targeted-conflict")
        && request.targets.is_some()
        && annotation_input == "host-installed-input";
    let input = if conflict || targeted_conflict {
        "complement-conflict-input"
    } else {
        supplemental_input.as_str()
    };
    let mut contributions = Vec::new();

    for call in &request.calls {
        if call.kind()? != NodeKind::CallExpression {
            continue;
        }
        if let Some(targets) = &request.targets
            && !targets.contains(call)
        {
            continue;
        }

        let text = call.text()?.unwrap_or_default();
        if !text.starts_with("getProduct(") {
            continue;
        }
        let location = call.location()?;
        let mut contribution = FactContribution::new(
            *call,
            json!({
                "text": text,
                "input": input,
                "annotation": format!("complement:{annotation_input}"),
                "secondaryInvocation": invocation,
            }),
        );
        if let Some(at) = location {
            contribution.evidence.push(Evidence {
                kind: "source".to_string(),
                message: "Complement fixture adapter read this call from the active snapshot."
                    .to_string(),
                at: Some(at),
                model_id: None,
                declaration: None,
            });
        }
        contributions.push(contribution);
    }

    Ok(contributions)
}

fn extract_derived_consumer<'a>(
    context: &'a Context<'_>,
    request: &FactRequest<'a>,
) -> Result<Vec<FactContribution<'a>>, AdapterError> {
    let mut contributions = Vec::new();
    if let Some(targets) = &request.targets {
        for &target in targets {
            if let Some(call) = resolve_consumer_call(target)?
                && let Some(contribution) = build_consumer_contribution(context, target, call)?
            {
                contributions.push(contribution);
            }
        }
        return Ok(contributions);
    }

    let mut covered_calls = Vec::new();
    for &variable in &request.variables {
        if let Some(call) = resolve_consumer_call(variable)?
            && let Some(contribution) = build_consumer_contribution(context, variable, call)?
        {
            covered_calls.push(call);
            contributions.push(contribution);
        }
    }
    for &call in &request.calls {
        if covered_calls.contains(&call) {
            continue;
        }
        if is_consume_fixture_source_call(call)?
            && let Some(contribution) = build_consumer_contribution(context, call, call)?
        {
            contributions.push(contribution);
        }
    }
    Ok(contributions)
}

fn resolve_consumer_call(node: NodeRef<'_>) -> Result<Option<NodeRef<'_>>, AdapterError> {
    let current = node.unwrap_expression()?.unwrap_or(node);
    match current.kind()? {
        NodeKind::CallExpression => Ok(is_consume_fixture_source_call(current)?.then_some(current)),
        NodeKind::VariableDeclaration => {
            let Some(init) = current.safe_initializer()? else {
                return Ok(None);
            };
            let init = init.unwrap_expression()?.unwrap_or(init);
            if init.kind()? == NodeKind::CallExpression && is_consume_fixture_source_call(init)? {
                Ok(Some(init))
            } else {
                Ok(None)
            }
        }
        NodeKind::Identifier => {
            let Some(decl) = current.declaration_node()? else {
                return Ok(None);
            };
            if decl == current {
                return Ok(None);
            }
            resolve_consumer_call(decl)
        }
        _ => Ok(None),
    }
}

fn is_consume_fixture_source_call(call: NodeRef<'_>) -> Result<bool, AdapterError> {
    if call.kind()? != NodeKind::CallExpression {
        return Ok(false);
    }
    let Some(callee) = call.expression()? else {
        return Ok(false);
    };
    let callee = callee.unwrap_expression()?.unwrap_or(callee);
    let text = callee.text()?.unwrap_or_default();
    Ok(text == "consumeFixtureSource" || text.ends_with(".consumeFixtureSource"))
}

struct DerivedConsumerState {
    source_name: String,
    fields: BTreeMap<String, String>,
    unknown_fields: BTreeSet<String>,
    field_gaps: BTreeMap<String, Vec<Gap>>,
    shape_gaps: Vec<Gap>,
    has_dynamic_fields: bool,
    evidence: Vec<Evidence>,
    source_providers: BTreeSet<String>,
}

fn build_consumer_contribution<'a>(
    context: &'a Context<'_>,
    subject: NodeRef<'a>,
    call: NodeRef<'a>,
) -> Result<Option<FactContribution<'a>>, AdapterError> {
    let args = call.arguments()?;
    let Some(&raw_source_arg) = args.first() else {
        return Ok(None);
    };
    let source_arg = raw_source_arg
        .unwrap_expression()?
        .unwrap_or(raw_source_arg);
    let target_a = if source_arg.kind()? == NodeKind::Identifier {
        source_arg.declaration_node()?.unwrap_or(source_arg)
    } else {
        source_arg
    };

    let queried = context.query_facts(&FactQuery {
        fact_type_id: "fixture.source-spec",
        provider_id: None,
        condition: None,
        targets: Some(&[target_a]),
    })?;

    let mut state = init_state_from_source_facts(&queried, source_arg)?;
    if let Some(&override_arg) = args.get(1) {
        apply_consumer_overrides(override_arg, &mut state)?;
    }

    let consumer_name = match subject.kind()? {
        NodeKind::VariableDeclaration => subject
            .name()?
            .and_then(|name| name.text().transpose())
            .transpose()?
            .unwrap_or_else(|| "consumer".to_string()),
        _ => subject.text()?.unwrap_or_else(|| "consumer".to_string()),
    };

    if let Some(at) = subject.location()? {
        state.evidence.push(Evidence {
            kind: "source".to_string(),
            message: format!(
                "Fixture consumer \"{consumer_name}\" derived from source \"{}\".",
                state.source_name
            ),
            at: Some(at),
            model_id: None,
            declaration: None,
        });
    }

    let mut all_gaps = state.shape_gaps;
    for gaps in state.field_gaps.into_values() {
        all_gaps.extend(gaps);
    }

    let required_fields = collect_fields_by_mode(&state.fields, "required");
    let optional_fields = collect_fields_by_mode(&state.fields, "optional");
    let defaulted_fields = collect_fields_by_mode(&state.fields, "defaulted");
    let unknown_fields: Vec<String> = state.unknown_fields.into_iter().collect();
    let has_dynamic_fields =
        state.has_dynamic_fields || !unknown_fields.is_empty() || !all_gaps.is_empty();
    let source_providers: Vec<String> = state.source_providers.into_iter().collect();

    let mut contribution = FactContribution::new(
        subject,
        json!({
            "consumerName": consumer_name,
            "sourceName": state.source_name,
            "fields": state.fields,
            "requiredFields": required_fields,
            "optionalFields": optional_fields,
            "defaultedFields": defaulted_fields,
            "unknownFields": unknown_fields,
            "hasDynamicFields": has_dynamic_fields,
            "sourceProviders": source_providers,
        }),
    );
    contribution.evidence = state.evidence;
    contribution.gaps = all_gaps;
    Ok(Some(contribution))
}

fn init_state_from_source_facts(
    queried: &[verule_adapter_api::QueriedFact<'_>],
    source_arg: NodeRef<'_>,
) -> Result<DerivedConsumerState, AdapterError> {
    let mut state = DerivedConsumerState {
        source_name: "unknown".to_string(),
        fields: BTreeMap::new(),
        unknown_fields: BTreeSet::new(),
        field_gaps: BTreeMap::new(),
        shape_gaps: Vec::new(),
        has_dynamic_fields: false,
        evidence: Vec::new(),
        source_providers: BTreeSet::new(),
    };

    let Some(fact) = queried.first() else {
        state.has_dynamic_fields = true;
        state.shape_gaps.push(Gap {
            kind: "unresolved-fixture-source".to_string(),
            message: "Could not resolve fixture source specification for consumer.".to_string(),
            at: source_arg.location()?,
        });
        return Ok(state);
    };

    if let Some(name) = fact.value.get("sourceName").and_then(Value::as_str) {
        state.source_name = name.to_string();
    }
    if let Some(fields_obj) = fact.value.get("fields").and_then(Value::as_object) {
        for (key, val) in fields_obj {
            if let Some(mode) = val.as_str() {
                state.fields.insert(key.clone(), mode.to_string());
            }
        }
    }
    if let Some(unknowns) = fact.value.get("unknownFields").and_then(Value::as_array) {
        for item in unknowns {
            if let Some(field) = item.as_str() {
                state.unknown_fields.insert(field.to_string());
            }
        }
    }
    if fact
        .value
        .get("hasDynamicFields")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        state.has_dynamic_fields = true;
    }
    for gap in &fact.gaps {
        let matched_field = state
            .unknown_fields
            .iter()
            .find(|field| gap.message.contains(&format!("\"{field}\"")))
            .cloned();
        if let Some(field) = matched_field {
            state.field_gaps.entry(field).or_default().push(gap.clone());
        } else {
            state.shape_gaps.push(gap.clone());
        }
    }
    state.evidence.extend(fact.evidence.clone());
    state.source_providers.extend(fact.providers.clone());
    Ok(state)
}

fn apply_consumer_overrides(
    override_arg: NodeRef<'_>,
    state: &mut DerivedConsumerState,
) -> Result<(), AdapterError> {
    let unwrapped = override_arg.unwrap_expression()?.unwrap_or(override_arg);
    if unwrapped.kind()? == NodeKind::UndefinedKeyword {
        return Ok(());
    }
    let Some(obj) = resolve_object_literal(unwrapped)? else {
        state.has_dynamic_fields = true;
        state.shape_gaps.push(Gap {
            kind: "dynamic-fixture-fields".to_string(),
            message: "Fixture consumer overrides could not be statically resolved.".to_string(),
            at: unwrapped.location()?,
        });
        return Ok(());
    };
    for prop in obj.properties()? {
        if prop.kind()? != NodeKind::PropertyAssignment {
            state.has_dynamic_fields = true;
            state.shape_gaps.push(Gap {
                kind: "dynamic-fixture-fields".to_string(),
                message: "Fixture consumer overrides contain dynamic members.".to_string(),
                at: prop.location()?,
            });
            continue;
        }
        let Some(key) = read_property_name(prop)? else {
            state.has_dynamic_fields = true;
            state.shape_gaps.push(Gap {
                kind: "unresolved-fixture-field".to_string(),
                message: "Fixture consumer override has a dynamic property key.".to_string(),
                at: prop.location()?,
            });
            continue;
        };
        let init = match prop.safe_initializer()? {
            Some(node) => Some(node),
            None => prop.initializer()?,
        };
        if let Some(init_node) = init
            && let Some(mode) = read_string_literal(init_node)?
            && matches!(mode.as_str(), "required" | "optional" | "defaulted")
        {
            state.fields.insert(key.clone(), mode.clone());
            state.unknown_fields.remove(&key);
            state.field_gaps.remove(&key);
            if let Some(at) = prop.location()? {
                state.evidence.push(Evidence {
                    kind: "source".to_string(),
                    message: format!("Fixture consumer overrode field \"{key}\" to \"{mode}\"."),
                    at: Some(at),
                    model_id: None,
                    declaration: None,
                });
            }
        } else {
            state.fields.remove(&key);
            state.unknown_fields.insert(key.clone());
            state.has_dynamic_fields = true;
            state.field_gaps.insert(
                key.clone(),
                vec![Gap {
                    kind: "unresolved-fixture-field".to_string(),
                    message: format!(
                        "Fixture consumer override for field \"{key}\" could not be statically resolved."
                    ),
                    at: init.map_or_else(|| prop.location(), NodeRef::location)?,
                }],
            );
        }
    }
    Ok(())
}

fn collect_fields_by_mode(fields: &BTreeMap<String, String>, mode: &str) -> Vec<String> {
    fields
        .iter()
        .filter(|(_, value)| value.as_str() == mode)
        .map(|(key, _)| key.clone())
        .collect()
}

fn resolve_object_literal(node: NodeRef<'_>) -> Result<Option<NodeRef<'_>>, AdapterError> {
    let current = node.unwrap_expression()?.unwrap_or(node);
    match current.kind()? {
        NodeKind::ObjectLiteralExpression => Ok(Some(current)),
        NodeKind::Identifier => {
            let Some(decl) = current.declaration_node()? else {
                return Ok(None);
            };
            let Some(init) = decl.safe_initializer()? else {
                return Ok(None);
            };
            let init = init.unwrap_expression()?.unwrap_or(init);
            Ok((init.kind()? == NodeKind::ObjectLiteralExpression).then_some(init))
        }
        _ => Ok(None),
    }
}

fn read_property_name(prop: NodeRef<'_>) -> Result<Option<String>, AdapterError> {
    let Some(name_node) = prop.name()? else {
        return Ok(None);
    };
    match name_node.kind()? {
        NodeKind::Identifier => Ok(name_node.text()?),
        NodeKind::StringLiteral | NodeKind::NoSubstitutionTemplateLiteral => {
            read_string_literal(name_node)
        }
        _ => Ok(None),
    }
}

fn read_string_literal(node: NodeRef<'_>) -> Result<Option<String>, AdapterError> {
    let node = node.unwrap_expression()?.unwrap_or(node);
    if !matches!(
        node.kind()?,
        NodeKind::StringLiteral | NodeKind::NoSubstitutionTemplateLiteral
    ) {
        return Ok(None);
    }
    let Some(raw) = node.text()? else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
            || (trimmed.starts_with('`') && trimmed.ends_with('`')))
    {
        Ok(Some(trimmed[1..trimmed.len() - 1].to_string()))
    } else {
        Ok(None)
    }
}

verule_adapter_api::export_adapter!(ComplementFixtureAdapter);
