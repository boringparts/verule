use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};
use verule_adapter_api::{
    AdapterError, Evidence, FactContribution, FactRequest, Gap, NodeKind, NodeRef, SourceLocation,
};

const INPUT_FACT: &str = "verule.validator.input-fields";
const OUTPUT_FACT: &str = "verule.validator.output-fields";
const VALIDATOR_METHODS: [&str; 4] = ["parse", "safeParse", "parseAsync", "safeParseAsync"];
const TABLE_BUILDERS: [&str; 8] = [
    "sqliteTable",
    "pgTable",
    "mysqlTable",
    "singlestoreTable",
    "pgView",
    "sqliteView",
    "mysqlView",
    "singlestoreView",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputRequirement {
    Required,
    Optional,
    Defaulted,
}

impl InputRequirement {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Optional => "optional",
            Self::Defaulted => "defaulted",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OutputPresence {
    Required,
    Optional,
}

impl OutputPresence {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Optional => "optional",
        }
    }
}

#[derive(Clone, Debug)]
struct Field {
    requirement: InputRequirement,
    presence: OutputPresence,
    nullable: bool,
    from_default: bool,
    evidence: Vec<Evidence>,
}

impl Default for Field {
    fn default() -> Self {
        Self::required(Vec::new())
    }
}

impl Field {
    const fn required(evidence: Vec<Evidence>) -> Self {
        Self {
            requirement: InputRequirement::Required,
            presence: OutputPresence::Required,
            nullable: false,
            from_default: false,
            evidence,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct FieldResult {
    field: Field,
    has_dynamic_fields: bool,
    gaps: Vec<Gap>,
}

#[derive(Clone, Debug, Default)]
struct Schema {
    recognized: bool,
    fields: BTreeMap<String, Field>,
    has_dynamic_fields: bool,
    gaps: Vec<Gap>,
    evidence: Vec<Evidence>,
}

impl Schema {
    fn unrecognized() -> Self {
        Self::default()
    }

    fn unresolved(message: String, at: Option<SourceLocation>) -> Self {
        Self {
            recognized: true,
            has_dynamic_fields: true,
            gaps: vec![Gap {
                kind: "unresolved-schema".to_string(),
                message,
                at: at.clone(),
            }],
            evidence: vec![source_evidence("Unresolved Zod schema".to_string(), at)],
            ..Self::default()
        }
    }

    fn add_evidence(&mut self, evidence: Evidence) {
        push_unique(&mut self.evidence, evidence);
    }

    fn add_gap(&mut self, gap: Gap) {
        push_unique(&mut self.gaps, gap);
        self.has_dynamic_fields = true;
    }
}

struct Site<'a> {
    subject: NodeRef<'a>,
    kind: &'static str,
    validator_method: Option<String>,
    schema_name: Option<String>,
    schema: Schema,
}

/// Extracts the shared validator facts directly from the compiler-independent snapshot API.
pub fn extract<'a>(request: &FactRequest<'a>) -> Result<Vec<FactContribution<'a>>, AdapterError> {
    let scope = request
        .condition
        .as_ref()
        .and_then(|condition| condition.get("scope"))
        .and_then(Value::as_str)
        .unwrap_or("all");
    let mut sites: Vec<Site<'a>> = Vec::new();

    if scope != "schemas" {
        for &call in &request.calls {
            if !is_target(request, call) {
                continue;
            }
            if let Some(site) = ZodEvaluator::validator_call(call)? {
                sites.push(site);
            }
        }
    }

    if scope != "calls" {
        for &variable in &request.variables {
            if !is_target(request, variable) {
                continue;
            }
            if let Some(site) = ZodEvaluator::schema_variable(variable)? {
                sites.push(site);
            }
        }

        if let Some(targets) = &request.targets {
            for &target in targets {
                if sites.iter().any(|site| site.subject == target) {
                    continue;
                }
                if matches!(
                    target.kind()?,
                    NodeKind::CallExpression | NodeKind::VariableDeclaration
                ) {
                    continue;
                }
                let schema = ZodEvaluator::evaluate_schema(target, &mut Vec::new())?;
                if schema.recognized {
                    sites.push(Site {
                        subject: target,
                        kind: "schema",
                        validator_method: None,
                        schema_name: if target.kind()? == NodeKind::Identifier {
                            Some(text(target)?)
                        } else {
                            None
                        },
                        schema,
                    });
                }
            }
        }
    }

    let mut contributions = Vec::with_capacity(sites.len());
    for site in sites {
        let value = match request.fact_type_id {
            INPUT_FACT => input_value(&site),
            OUTPUT_FACT => output_value(&site),
            _ => {
                return Err(AdapterError::UnsupportedFactType {
                    adapter_id: "zod".to_string(),
                    fact_type_id: request.fact_type_id.to_string(),
                });
            }
        };
        let mut contribution = FactContribution::new(site.subject, value);
        contribution.evidence = dedupe_evidence(site.schema.evidence);
        contribution.gaps = dedupe_gaps(site.schema.gaps);
        contributions.push(contribution);
    }
    Ok(contributions)
}

fn is_target(request: &FactRequest<'_>, node: NodeRef<'_>) -> bool {
    request
        .targets
        .as_ref()
        .is_none_or(|targets| targets.contains(&node))
}

fn input_value(site: &Site) -> Value {
    let mut required = Vec::new();
    let mut optional = Vec::new();
    let mut defaulted = Vec::new();
    let mut fields = Map::new();
    for (name, field) in &site.schema.fields {
        match field.requirement {
            InputRequirement::Required => required.push(name.clone()),
            InputRequirement::Optional => optional.push(name.clone()),
            InputRequirement::Defaulted => {
                optional.push(name.clone());
                defaulted.push(name.clone());
            }
        }
        let mut value = json!({
            "name": name,
            "requirement": field.requirement.as_str(),
            "nullable": field.nullable,
        });
        if !field.evidence.is_empty() {
            value["evidence"] = json!(dedupe_evidence(field.evidence.clone()));
        }
        fields.insert(name.clone(), value);
    }
    let mut value = json!({
        "siteKind": site.kind,
        "requiredFields": required,
        "optionalFields": optional,
        "defaultedFields": defaulted,
        "fields": fields,
        "hasDynamicFields": site.schema.has_dynamic_fields,
    });
    add_site_metadata(&mut value, site);
    value
}

fn output_value(site: &Site) -> Value {
    let mut present = Vec::new();
    let mut optional = Vec::new();
    let mut defaulted = Vec::new();
    let mut fields = Map::new();
    for (name, field) in &site.schema.fields {
        match field.presence {
            OutputPresence::Required => present.push(name.clone()),
            OutputPresence::Optional => optional.push(name.clone()),
        }
        if field.from_default {
            defaulted.push(name.clone());
        }
        let mut value = json!({
            "name": name,
            "presence": field.presence.as_str(),
            "nullable": field.nullable,
            "fromDefault": field.from_default,
        });
        if !field.evidence.is_empty() {
            value["evidence"] = json!(dedupe_evidence(field.evidence.clone()));
        }
        fields.insert(name.clone(), value);
    }
    let mut value = json!({
        "siteKind": site.kind,
        "presentFields": present,
        "optionalFields": optional,
        "defaultedFields": defaulted,
        "fields": fields,
        "hasDynamicFields": site.schema.has_dynamic_fields,
    });
    add_site_metadata(&mut value, site);
    value
}

fn add_site_metadata(value: &mut Value, site: &Site) {
    if let Some(method) = &site.validator_method {
        value["validatorMethod"] = json!(method);
    }
    if let Some(name) = &site.schema_name {
        value["schemaName"] = json!(name);
    }
}

struct ZodEvaluator;

impl ZodEvaluator {
    fn validator_call(call: NodeRef<'_>) -> Result<Option<Site<'_>>, AdapterError> {
        if call.kind()? != NodeKind::CallExpression {
            return Ok(None);
        }
        let Some((method, Some(receiver))) = call_parts(call)? else {
            return Ok(None);
        };
        if !VALIDATOR_METHODS.contains(&method.as_str()) {
            return Ok(None);
        }
        let schema = Self::evaluate_schema(receiver, &mut Vec::new())?;
        if !schema.recognized {
            return Ok(None);
        }
        let mut schema = schema;
        schema.add_evidence(source_evidence(
            format!("Validator call .{method}()"),
            call.location()?,
        ));
        Ok(Some(Site {
            subject: call,
            kind: "call",
            validator_method: Some(method),
            schema_name: if receiver.kind()? == NodeKind::Identifier {
                Some(text(receiver)?)
            } else {
                None
            },
            schema,
        }))
    }

    fn schema_variable(variable: NodeRef<'_>) -> Result<Option<Site<'_>>, AdapterError> {
        if variable.kind()? != NodeKind::VariableDeclaration {
            return Ok(None);
        }
        let Some(initializer) = variable.safe_initializer()? else {
            return Ok(None);
        };
        if !matches!(
            unwrap(initializer)?.kind()?,
            NodeKind::CallExpression | NodeKind::Identifier | NodeKind::PropertyAccessExpression
        ) {
            return Ok(None);
        }
        let schema = Self::evaluate_schema(initializer, &mut Vec::new())?;
        if !schema.recognized {
            return Ok(None);
        }
        let schema_name = variable.name()?.map(text).transpose()?;
        Ok(Some(Site {
            subject: variable,
            kind: "schema",
            validator_method: None,
            schema_name,
            schema,
        }))
    }

    fn evaluate_schema<'a>(
        expression: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        let expression = unwrap(expression)?;
        match expression.kind()? {
            NodeKind::Identifier => Self::evaluate_identifier(expression, visited),
            NodeKind::PropertyAccessExpression => {
                let Some((name, receiver)) = property_access(expression)? else {
                    return Ok(Schema::unrecognized());
                };
                if name == "shape"
                    && let Some(receiver) = receiver
                {
                    return Self::evaluate_schema(receiver, visited);
                }
                if is_zod_type(expression)? {
                    Ok(Schema::unresolved(
                        format!(
                            "Zod schema reference \"{}\" has no statically resolvable object shape.",
                            text(expression)?
                        ),
                        expression.location()?,
                    ))
                } else {
                    Ok(Schema::unrecognized())
                }
            }
            NodeKind::CallExpression => Self::evaluate_schema_call(expression, visited),
            _ if is_zod_type(expression)? => Ok(Schema::unresolved(
                format!(
                    "Zod schema expression \"{}\" could not be statically expanded.",
                    text(expression)?
                ),
                expression.location()?,
            )),
            _ => Ok(Schema::unrecognized()),
        }
    }

    fn evaluate_identifier<'a>(
        identifier: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        if let Some(declaration) = identifier.declaration_node()? {
            if visited.contains(&declaration) {
                return Ok(Schema::unresolved(
                    format!(
                        "Recursive Zod schema reference \"{}\" stops static expansion.",
                        text(identifier)?
                    ),
                    identifier.location()?,
                ));
            }
            visited.push(declaration);
            let result = if let Some(initializer) = declaration.safe_initializer()? {
                Self::evaluate_schema(initializer, visited)?
            } else {
                Schema::unrecognized()
            };
            visited.pop();
            if result.recognized {
                return Ok(result);
            }
        }
        if is_zod_type(identifier)? {
            return Ok(Schema::unresolved(
                format!(
                    "Zod schema \"{}\" has no statically resolvable local definition.",
                    text(identifier)?
                ),
                identifier.location()?,
            ));
        }
        Ok(Schema::unrecognized())
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Schema factory forms share one ordered dispatch over the public syntax API."
    )]
    fn evaluate_schema_call<'a>(
        call: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        let Some((method, receiver)) = call_parts(call)? else {
            return Ok(Schema::unrecognized());
        };
        let arguments = call.arguments()?;
        let location = call.location()?;

        if matches!(method.as_str(), "object" | "strictObject" | "looseObject")
            && receiver.is_some_and(is_zod_namespace)
        {
            let mut schema = if let Some(shape) = arguments.first() {
                Self::evaluate_shape(*shape, visited)?
            } else {
                Schema {
                    recognized: true,
                    ..Schema::default()
                }
            };
            schema.recognized = true;
            schema.add_evidence(source_evidence(
                format!("Zod object schema defined via z.{method}()"),
                location,
            ));
            return Ok(schema);
        }

        if method == "createSelectSchema" {
            let mut schema = if let Some(table) = arguments.first() {
                Self::evaluate_table_schema(*table, visited)?
            } else {
                Schema::unresolved(
                    "createSelectSchema() has no statically resolvable table argument.".to_string(),
                    location.clone(),
                )
            };
            schema.recognized = true;
            schema.add_evidence(source_evidence(
                "Zod schema derived from a Drizzle table".to_string(),
                location.clone(),
            ));
            for (name, field) in &mut schema.fields {
                push_unique(
                    &mut field.evidence,
                    source_evidence(
                        format!("Field \"{name}\" included in Drizzle-derived Zod schema"),
                        location.clone(),
                    ),
                );
            }
            if let Some(refinements) = arguments.get(1) {
                let overrides = Self::evaluate_shape(*refinements, visited)?;
                merge_fields(&mut schema.fields, overrides.fields);
                schema.has_dynamic_fields |= overrides.has_dynamic_fields;
                schema.gaps.extend(overrides.gaps);
                schema.evidence.extend(overrides.evidence);
            }
            return Ok(schema);
        }

        if matches!(method.as_str(), "record" | "union" | "discriminatedUnion")
            && receiver.is_some_and(is_zod_namespace)
        {
            if method == "record" {
                let mut schema = Schema {
                    recognized: true,
                    has_dynamic_fields: true,
                    ..Schema::default()
                };
                schema.add_gap(Gap {
                    kind: "dynamic-schema-shape".to_string(),
                    message:
                        "Schema uses z.record() whose object keys cannot be statically enumerated."
                            .to_string(),
                    at: location.clone(),
                });
                schema.add_evidence(source_evidence(
                    "Dynamic Zod record schema".to_string(),
                    location,
                ));
                return Ok(schema);
            }
            return Self::evaluate_union(call, method.as_str(), &arguments, visited);
        }

        if method == "intersection" && receiver.is_some_and(is_zod_namespace) {
            if let (Some(left), Some(right)) = (arguments.first(), arguments.get(1)) {
                let left = Self::evaluate_schema(*left, visited)?;
                let right = Self::evaluate_schema(*right, visited)?;
                return Ok(intersection_schema(
                    location,
                    left,
                    right,
                    "z.intersection()",
                ));
            }
            return Ok(Schema::unresolved(
                "z.intersection() requires two statically resolvable schemas.".to_string(),
                location,
            ));
        }

        if let Some(receiver) = receiver
            && let Some(schema) =
                Self::evaluate_composition(call, &method, receiver, &arguments, visited)?
        {
            return Ok(schema);
        }

        if is_zod_type(call)? {
            Ok(Schema::unresolved(
                format!(
                    "Zod schema call \"{}\" could not be statically expanded.",
                    text(call)?
                ),
                location,
            ))
        } else {
            Ok(Schema::unrecognized())
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Composition methods mutate one schema summary and share common evidence handling."
    )]
    fn evaluate_composition<'a>(
        call: NodeRef<'a>,
        method: &str,
        receiver: NodeRef<'a>,
        arguments: &[NodeRef<'a>],
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Option<Schema>, AdapterError> {
        let location = call.location()?;
        let base = Self::evaluate_schema(receiver, visited)?;
        if !base.recognized {
            return Ok(None);
        }
        let mut result = base;
        result.add_evidence(source_evidence(
            format!("Schema composed with .{method}()"),
            location.clone(),
        ));

        match method {
            "extend" => {
                if let Some(shape) = arguments.first() {
                    let extension = Self::evaluate_shape(*shape, visited)?;
                    merge_fields(&mut result.fields, extension.fields);
                    result.has_dynamic_fields |= extension.has_dynamic_fields;
                    result.gaps.extend(extension.gaps);
                    result.evidence.extend(extension.evidence);
                }
            }
            "merge" => {
                if let Some(other) = arguments.first() {
                    let other = Self::evaluate_schema(*other, visited)?;
                    if other.recognized {
                        merge_fields(&mut result.fields, other.fields);
                        result.has_dynamic_fields |= other.has_dynamic_fields;
                        result.gaps.extend(other.gaps);
                        result.evidence.extend(other.evidence);
                    } else {
                        result.add_gap(Gap {
                            kind: "unresolved-schema".to_string(),
                            message: "Argument to .merge() could not be statically resolved as a Zod object schema.".to_string(),
                            at: location,
                        });
                    }
                }
            }
            "pick" | "omit" => {
                if let Some(mask_expression) = arguments.first() {
                    let mask = Self::evaluate_mask(*mask_expression, visited)?;
                    let mut selected = BTreeMap::new();
                    for (name, field) in result.fields {
                        let included = mask.keys.contains(&name);
                        if (method == "pick" && included) || (method == "omit" && !included) {
                            selected.insert(name, field);
                        }
                    }
                    result.fields = selected;
                    result.has_dynamic_fields |= mask.has_dynamic_fields;
                    result.gaps.extend(mask.gaps);
                } else {
                    result.add_gap(Gap {
                        kind: "dynamic-schema-mask".to_string(),
                        message: format!(".{method}() called without a static field mask."),
                        at: location,
                    });
                }
            }
            "partial" | "required" => {
                let mask = if let Some(mask_expression) = arguments.first() {
                    if mask_expression.kind()? == NodeKind::UndefinedKeyword {
                        None
                    } else {
                        Some(Self::evaluate_mask(*mask_expression, visited)?)
                    }
                } else {
                    None
                };
                for (name, field) in &mut result.fields {
                    let applies = mask.as_ref().is_none_or(|mask| mask.keys.contains(name));
                    if applies {
                        let requirement = if method == "partial" {
                            InputRequirement::Optional
                        } else {
                            InputRequirement::Required
                        };
                        field.requirement = requirement;
                        field.presence = if method == "partial" {
                            OutputPresence::Optional
                        } else {
                            OutputPresence::Required
                        };
                        field.from_default = false;
                    }
                }
                if let Some(mask) = mask {
                    result.has_dynamic_fields |= mask.has_dynamic_fields;
                    result.gaps.extend(mask.gaps);
                }
            }
            "and" => {
                if let Some(other) = arguments.first() {
                    let other = Self::evaluate_schema(*other, visited)?;
                    result = intersection_schema(location, result, other, ".and()");
                }
            }
            "or" => {
                if let Some(other) = arguments.first() {
                    let other = Self::evaluate_schema(*other, visited)?;
                    result = union_schema(location, &[result, other], ".or()");
                }
            }
            "pipe" => {
                if let Some(output_expression) = arguments.first() {
                    let output = Self::evaluate_schema(*output_expression, visited)?;
                    if output.recognized {
                        result = pipe_schema(location, &result, &output);
                    } else {
                        result.add_gap(Gap {
                            kind: "unresolved-schema".to_string(),
                            message: ".pipe() output schema could not be statically resolved."
                                .to_string(),
                            at: location,
                        });
                    }
                }
            }
            "transform" | "refine" | "superRefine" | "check" | "openapi" | "describe" | "meta"
            | "brand" | "readonly" => {}
            _ => return Ok(None),
        }
        result.recognized = true;
        Ok(Some(result))
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Property kinds are handled together to preserve one pass and consistent dynamic gaps."
    )]
    fn evaluate_shape<'a>(
        expression: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        let expression = unwrap(expression)?;
        if expression.kind()? == NodeKind::Identifier
            && let Some(declaration) = expression.declaration_node()?
            && !visited.contains(&declaration)
        {
            visited.push(declaration);
            let result = if let Some(initializer) = declaration.safe_initializer()? {
                Self::evaluate_shape(initializer, visited)?
            } else {
                Schema::unrecognized()
            };
            visited.pop();
            if result.recognized {
                return Ok(result);
            }
        }
        if expression.kind()? != NodeKind::ObjectLiteralExpression {
            if let Some((name, Some(receiver))) = property_access(expression)?
                && name == "shape"
            {
                return Self::evaluate_schema(receiver, visited);
            }
            return Ok(Schema::unresolved(
                format!(
                    "Zod object shape \"{}\" is not a statically inspectable object literal.",
                    text(expression)?
                ),
                expression.location()?,
            ));
        }

        let mut schema = Schema {
            recognized: true,
            ..Schema::default()
        };
        schema.add_evidence(source_evidence(
            "Zod object field shape".to_string(),
            expression.location()?,
        ));
        for property in expression.properties()? {
            match property.kind()? {
                NodeKind::PropertyAssignment => {
                    let Some(name_node) = property.name()? else {
                        schema.add_gap(dynamic_gap(
                            "dynamic-schema-field",
                            "Zod object field has no statically inspectable name.".to_string(),
                            property.location()?,
                        ));
                        continue;
                    };
                    let Some(name) = static_property_name(name_node)? else {
                        schema.add_gap(dynamic_gap(
                            "dynamic-schema-field",
                            format!(
                                "Computed property name \"{}\" in Zod schema cannot be statically resolved.",
                                text(name_node)?
                            ),
                            name_node.location()?,
                        ));
                        continue;
                    };
                    let field_location = property.location()?;
                    let field_evidence = vec![source_evidence(
                        format!("Field \"{name}\" defined in Zod schema"),
                        field_location,
                    )];
                    let field = if let Some(initializer) = property.safe_initializer()? {
                        Self::evaluate_field(initializer, field_evidence, visited)?
                    } else {
                        FieldResult {
                            field: Field::required(field_evidence),
                            has_dynamic_fields: true,
                            gaps: vec![Gap {
                                kind: "unresolved-schema-field".to_string(),
                                message: format!(
                                    "Field \"{name}\" has no inspectable schema initializer."
                                ),
                                at: property.location()?,
                            }],
                        }
                    };
                    schema.has_dynamic_fields |= field.has_dynamic_fields;
                    schema.gaps.extend(field.gaps);
                    schema.evidence.extend(field.field.evidence.clone());
                    schema.fields.insert(name, field.field);
                }
                NodeKind::ShorthandPropertyAssignment => {
                    let Some(name_node) = property.name()? else {
                        schema.add_gap(dynamic_gap(
                            "dynamic-schema-field",
                            "Zod shorthand field has no statically inspectable name.".to_string(),
                            property.location()?,
                        ));
                        continue;
                    };
                    let name = text(name_node)?;
                    let field_evidence = vec![source_evidence(
                        format!("Field \"{name}\" defined in Zod schema"),
                        property.location()?,
                    )];
                    let field = if let Some(declaration) = property.declaration_node()? {
                        if let Some(initializer) = declaration.safe_initializer()? {
                            Self::evaluate_field(initializer, field_evidence, visited)?
                        } else {
                            unresolved_field(field_evidence, property.location()?)
                        }
                    } else {
                        unresolved_field(field_evidence, property.location()?)
                    };
                    schema.has_dynamic_fields |= field.has_dynamic_fields;
                    schema.gaps.extend(field.gaps);
                    schema.evidence.extend(field.field.evidence.clone());
                    schema.fields.insert(name, field.field);
                }
                NodeKind::SpreadAssignment => {
                    let expression = property.expression()?.or_else(|| {
                        property
                            .children()
                            .ok()
                            .and_then(|children| children.last().copied())
                    });
                    if let Some(expression) = expression {
                        let spread = Self::evaluate_shape(expression, visited)?;
                        if spread.recognized
                            && spread.has_dynamic_fields
                            && spread.fields.is_empty()
                        {
                            schema.add_gap(dynamic_gap(
                                "dynamic-schema-spread",
                                format!(
                                    "Spread \"{}\" in Zod schema shape cannot be statically resolved.",
                                    text(property)?
                                ),
                                property.location()?,
                            ));
                            schema.evidence.extend(spread.evidence);
                        } else if spread.recognized {
                            merge_fields(&mut schema.fields, spread.fields);
                            schema.has_dynamic_fields |= spread.has_dynamic_fields;
                            schema.gaps.extend(spread.gaps);
                            schema.evidence.extend(spread.evidence);
                        } else {
                            schema.add_gap(dynamic_gap(
                                "dynamic-schema-spread",
                                format!("Spread \"{}\" in Zod schema shape cannot be statically resolved.", text(property)?),
                                property.location()?,
                            ));
                        }
                    } else {
                        schema.add_gap(dynamic_gap(
                            "dynamic-schema-spread",
                            format!(
                                "Spread \"{}\" in Zod schema shape cannot be statically resolved.",
                                text(property)?
                            ),
                            property.location()?,
                        ));
                    }
                }
                _ => schema.add_gap(dynamic_gap(
                    "dynamic-schema-field",
                    format!(
                        "Unsupported dynamic member \"{}\" in Zod schema shape.",
                        text(property)?
                    ),
                    property.location()?,
                )),
            }
        }
        schema.evidence = dedupe_evidence(schema.evidence);
        schema.gaps = dedupe_gaps(schema.gaps);
        Ok(schema)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Field modifiers are evaluated together so their input and output effects stay explicit."
    )]
    fn evaluate_field<'a>(
        expression: NodeRef<'a>,
        evidence: Vec<Evidence>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<FieldResult, AdapterError> {
        let expression = unwrap(expression)?;
        if expression.kind()? == NodeKind::Identifier
            && let Some(declaration) = expression.declaration_node()?
            && !visited.contains(&declaration)
        {
            visited.push(declaration);
            let result = if let Some(initializer) = declaration.safe_initializer()? {
                Self::evaluate_field(initializer, evidence, visited)?
            } else {
                unresolved_field(evidence, expression.location()?)
            };
            visited.pop();
            return Ok(result);
        }

        if expression.kind()? == NodeKind::CallExpression
            && let Some((method, Some(receiver))) = call_parts(expression)?
        {
            let type_is_zod = is_zod_type(expression)?;
            let is_modifier = matches!(
                method.as_str(),
                "optional"
                    | "nullish"
                    | "nullable"
                    | "default"
                    | "prefault"
                    | "catch"
                    | "nonoptional"
                    | "transform"
                    | "refine"
                    | "superRefine"
                    | "check"
                    | "openapi"
                    | "describe"
                    | "meta"
                    | "brand"
                    | "readonly"
                    | "pipe"
                    | "preprocess"
            );
            if type_is_zod || is_modifier {
                if matches!(
                    method.as_str(),
                    "optional"
                        | "nullish"
                        | "nullable"
                        | "default"
                        | "prefault"
                        | "catch"
                        | "nonoptional"
                ) {
                    let mut inner = Self::evaluate_field(receiver, evidence, visited)?;
                    match method.as_str() {
                        "optional" => {
                            inner.field.requirement = InputRequirement::Optional;
                            inner.field.presence = OutputPresence::Optional;
                            inner.field.from_default = false;
                        }
                        "nullish" => {
                            inner.field.requirement = InputRequirement::Optional;
                            inner.field.presence = OutputPresence::Optional;
                            inner.field.nullable = true;
                            inner.field.from_default = false;
                        }
                        "nullable" => inner.field.nullable = true,
                        "default" | "prefault" | "catch" => {
                            inner.field.requirement = InputRequirement::Defaulted;
                            inner.field.presence = OutputPresence::Required;
                            inner.field.from_default = true;
                        }
                        "nonoptional" => {
                            inner.field.requirement = InputRequirement::Required;
                            inner.field.presence = OutputPresence::Required;
                            inner.field.from_default = false;
                        }
                        _ => {}
                    }
                    return Ok(inner);
                }
                if matches!(
                    method.as_str(),
                    "transform"
                        | "refine"
                        | "superRefine"
                        | "check"
                        | "openapi"
                        | "describe"
                        | "meta"
                        | "brand"
                        | "readonly"
                ) {
                    return Self::evaluate_field(receiver, evidence, visited);
                }
                if method == "pipe" {
                    let left = Self::evaluate_field(receiver, evidence.clone(), visited)?;
                    if let Some(output) = expression.arguments()?.first() {
                        let right = Self::evaluate_field(*output, evidence, visited)?;
                        let mut field = left.field;
                        field.presence = right.field.presence;
                        field.nullable = right.field.nullable;
                        field.from_default |= right.field.from_default;
                        field.evidence.extend(right.field.evidence);
                        return Ok(FieldResult {
                            field,
                            has_dynamic_fields: left.has_dynamic_fields || right.has_dynamic_fields,
                            gaps: [left.gaps, right.gaps].concat(),
                        });
                    }
                }
                if method == "preprocess"
                    && let Some(schema) = expression.arguments()?.last()
                {
                    return Self::evaluate_field(*schema, evidence, visited);
                }
                if matches!(method.as_str(), "record" | "any" | "unknown" | "custom")
                    && is_zod_namespace(receiver)
                {
                    return Ok(FieldResult {
                        field: Field::required(evidence),
                        has_dynamic_fields: true,
                        gaps: vec![dynamic_gap(
                            "dynamic-schema-field",
                            format!(
                                "Field uses dynamic Zod type z.{method}() whose constraints cannot be statically determined."
                            ),
                            expression.location()?,
                        )],
                    });
                }
                return Ok(FieldResult {
                    field: Field::required(evidence),
                    ..FieldResult::default()
                });
            }
        }

        if is_zod_type(expression)? {
            return Ok(FieldResult {
                field: Field::required(evidence),
                ..FieldResult::default()
            });
        }
        Ok(unresolved_field(evidence, expression.location()?))
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Table-derived fields are extracted in one pass with per-column evidence and gaps."
    )]
    fn evaluate_table_schema<'a>(
        table_expression: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        let table_expression = unwrap(table_expression)?;
        let declaration = if table_expression.kind()? == NodeKind::Identifier {
            table_expression.declaration_node()?
        } else {
            None
        };
        let initializer = if let Some(declaration) = declaration {
            if visited.contains(&declaration) {
                None
            } else {
                visited.push(declaration);
                let initializer = declaration.safe_initializer()?;
                visited.pop();
                initializer
            }
        } else if table_expression.kind()? == NodeKind::CallExpression {
            Some(table_expression)
        } else {
            None
        };
        let Some(initializer) = initializer else {
            return Ok(Schema::unresolved(
                format!(
                    "Drizzle table reference \"{}\" has no statically resolvable declaration.",
                    text(table_expression)?
                ),
                table_expression.location()?,
            ));
        };
        let Some((builder, _)) = call_parts(initializer)? else {
            return Ok(Schema::unresolved(
                "Drizzle table initializer is not a recognized table builder call.".to_string(),
                initializer.location()?,
            ));
        };
        if !TABLE_BUILDERS.contains(&builder.as_str()) && !is_table_type(initializer)? {
            return Ok(Schema::unresolved(
                format!("Drizzle table builder \"{builder}\" is not recognized."),
                initializer.location()?,
            ));
        }
        let arguments = initializer.arguments()?;
        let Some(columns) = arguments.get(1) else {
            return Ok(Schema::unresolved(
                "Drizzle table builder has no statically inspectable column object.".to_string(),
                initializer.location()?,
            ));
        };
        let columns = unwrap(*columns)?;
        if columns.kind()? != NodeKind::ObjectLiteralExpression {
            return Ok(Schema::unresolved(
                "Drizzle table columns are not a static object literal.".to_string(),
                columns.location()?,
            ));
        }

        let mut schema = Schema {
            recognized: true,
            ..Schema::default()
        };
        schema.add_evidence(source_evidence(
            "Drizzle table columns used to derive a Zod schema".to_string(),
            initializer.location()?,
        ));
        for column in columns.properties()? {
            if column.kind()? != NodeKind::PropertyAssignment {
                schema.add_gap(dynamic_gap(
                    "dynamic-schema-table",
                    format!(
                        "Drizzle table column member \"{}\" is not a static property.",
                        text(column)?
                    ),
                    column.location()?,
                ));
                continue;
            }
            let Some(name_node) = column.name()? else {
                schema.add_gap(dynamic_gap(
                    "dynamic-schema-table",
                    "Drizzle table column has no static name.".to_string(),
                    column.location()?,
                ));
                continue;
            };
            let Some(name) = static_property_name(name_node)? else {
                schema.add_gap(dynamic_gap(
                    "dynamic-schema-table",
                    format!(
                        "Drizzle table column key \"{}\" is dynamic.",
                        text(name_node)?
                    ),
                    name_node.location()?,
                ));
                continue;
            };
            let Some(column_expression) = column.safe_initializer()? else {
                schema.add_gap(dynamic_gap(
                    "dynamic-schema-table",
                    format!("Drizzle column \"{name}\" has no inspectable builder."),
                    column.location()?,
                ));
                continue;
            };
            let nullable = Self::drizzle_column_nullable(column_expression)?;
            let evidence = source_evidence(
                format!("Field \"{name}\" defined in Drizzle table"),
                column.location()?,
            );
            let field = Field {
                requirement: InputRequirement::Required,
                presence: OutputPresence::Required,
                nullable,
                from_default: false,
                evidence: vec![evidence.clone()],
            };
            schema.add_evidence(evidence);
            schema.fields.insert(name, field);
        }
        Ok(schema)
    }

    fn drizzle_column_nullable(expression: NodeRef<'_>) -> Result<bool, AdapterError> {
        let mut current = unwrap(expression)?;
        let mut nullable = true;
        let mut visited = Vec::new();
        while current.kind()? == NodeKind::CallExpression && !visited.contains(&current) {
            visited.push(current);
            let Some((method, receiver)) = call_parts(current)? else {
                break;
            };
            if method == "notNull" || method == "primaryKey" {
                nullable = false;
            }
            let Some(receiver) = receiver else {
                break;
            };
            current = unwrap(receiver)?;
        }
        Ok(nullable)
    }

    fn evaluate_mask<'a>(
        expression: NodeRef<'a>,
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Mask, AdapterError> {
        let expression = unwrap(expression)?;
        if expression.kind()? == NodeKind::Identifier
            && let Some(declaration) = expression.declaration_node()?
            && !visited.contains(&declaration)
        {
            visited.push(declaration);
            let result = if let Some(initializer) = declaration.safe_initializer()? {
                Self::evaluate_mask(initializer, visited)?
            } else {
                Mask::dynamic(expression.location()?)
            };
            visited.pop();
            return Ok(result);
        }
        if expression.kind()? != NodeKind::ObjectLiteralExpression {
            return Ok(Mask::dynamic(expression.location()?));
        }
        let mut mask = Mask::default();
        for property in expression.properties()? {
            if property.kind()? != NodeKind::PropertyAssignment {
                mask.has_dynamic_fields = true;
                mask.gaps.push(dynamic_gap(
                    "dynamic-schema-mask",
                    "Schema field mask contains a dynamic member.".to_string(),
                    property.location()?,
                ));
                continue;
            }
            let (Some(name_node), Some(value_node)) =
                (property.name()?, property.safe_initializer()?)
            else {
                mask.has_dynamic_fields = true;
                continue;
            };
            let Some(name) = static_property_name(name_node)? else {
                mask.has_dynamic_fields = true;
                mask.gaps.push(dynamic_gap(
                    "dynamic-schema-mask",
                    "Schema field mask contains a dynamic key.".to_string(),
                    name_node.location()?,
                ));
                continue;
            };
            match unwrap(value_node)?.kind()? {
                NodeKind::TrueKeyword => {
                    mask.keys.insert(name);
                }
                NodeKind::FalseKeyword => {}
                _ => {
                    mask.has_dynamic_fields = true;
                    mask.gaps.push(dynamic_gap(
                        "dynamic-schema-mask",
                        format!("Schema field mask for \"{name}\" is not a static boolean."),
                        property.location()?,
                    ));
                }
            }
        }
        Ok(mask)
    }

    fn evaluate_union<'a>(
        call: NodeRef<'a>,
        method: &str,
        arguments: &[NodeRef<'a>],
        visited: &mut Vec<NodeRef<'a>>,
    ) -> Result<Schema, AdapterError> {
        let argument_index = usize::from(method == "discriminatedUnion");
        let Some(options) = arguments.get(argument_index) else {
            return Ok(Schema::unresolved(
                "Zod union has no statically resolvable option array.".to_string(),
                call.location()?,
            ));
        };
        let options = unwrap(*options)?;
        if options.kind()? != NodeKind::ArrayLiteralExpression {
            return Ok(Schema::unresolved(
                "Zod union options are not a static array literal.".to_string(),
                options.location()?,
            ));
        }
        let mut branches = Vec::new();
        for branch in options.children()? {
            let schema = Self::evaluate_schema(branch, visited)?;
            branches.push(schema);
        }
        Ok(union_schema(call.location()?, &branches, method))
    }
}

#[derive(Clone, Debug, Default)]
struct Mask {
    keys: BTreeSet<String>,
    has_dynamic_fields: bool,
    gaps: Vec<Gap>,
}

impl Mask {
    fn dynamic(at: Option<SourceLocation>) -> Self {
        Self {
            has_dynamic_fields: true,
            gaps: vec![Gap {
                kind: "dynamic-schema-mask".to_string(),
                message: "Schema field mask could not be statically inspected.".to_string(),
                at,
            }],
            ..Self::default()
        }
    }
}

fn union_schema(location: Option<SourceLocation>, branches: &[Schema], label: &str) -> Schema {
    if branches.is_empty() {
        return Schema::unresolved(
            format!("Empty {label} schema has indeterminate fields."),
            location,
        );
    }
    let mut output = Schema {
        recognized: true,
        has_dynamic_fields: branches
            .iter()
            .any(|branch| !branch.recognized || branch.has_dynamic_fields),
        ..Schema::default()
    };
    for branch in branches {
        output.gaps.extend(branch.gaps.clone());
        output.evidence.extend(branch.evidence.clone());
    }
    let names = branches
        .iter()
        .flat_map(|branch| branch.fields.keys().cloned())
        .collect::<BTreeSet<_>>();
    for name in names {
        let all_present = branches
            .iter()
            .all(|branch| branch.fields.contains_key(&name));
        let fields = branches
            .iter()
            .filter_map(|branch| branch.fields.get(&name))
            .collect::<Vec<_>>();
        let required = all_present
            && fields
                .iter()
                .all(|field| field.requirement == InputRequirement::Required);
        let all_defaulted = all_present
            && fields
                .iter()
                .all(|field| field.requirement == InputRequirement::Defaulted);
        let output_required = all_present
            && fields
                .iter()
                .all(|field| field.presence == OutputPresence::Required);
        let evidence = dedupe_evidence(
            fields
                .iter()
                .flat_map(|field| field.evidence.clone())
                .collect(),
        );
        output.fields.insert(
            name,
            Field {
                requirement: if required {
                    InputRequirement::Required
                } else if all_defaulted {
                    InputRequirement::Defaulted
                } else {
                    InputRequirement::Optional
                },
                presence: if output_required {
                    OutputPresence::Required
                } else {
                    OutputPresence::Optional
                },
                nullable: fields.iter().any(|field| field.nullable),
                from_default: output_required && fields.iter().any(|field| field.from_default),
                evidence,
            },
        );
    }
    output.add_evidence(source_evidence(format!("Zod {label} schema"), location));
    output.gaps = dedupe_gaps(output.gaps);
    output.evidence = dedupe_evidence(output.evidence);
    output
}

fn intersection_schema(
    location: Option<SourceLocation>,
    left: Schema,
    right: Schema,
    label: &str,
) -> Schema {
    let mut output = Schema {
        recognized: left.recognized || right.recognized,
        has_dynamic_fields: !left.recognized
            || !right.recognized
            || left.has_dynamic_fields
            || right.has_dynamic_fields,
        fields: left.fields.clone(),
        gaps: [left.gaps.clone(), right.gaps.clone()].concat(),
        evidence: [left.evidence, right.evidence.clone()].concat(),
    };
    for (name, right_field) in right.fields {
        if let Some(left_field) = output.fields.get_mut(&name) {
            left_field.requirement = if left_field.requirement == InputRequirement::Required
                || right_field.requirement == InputRequirement::Required
            {
                InputRequirement::Required
            } else if left_field.requirement == InputRequirement::Defaulted
                || right_field.requirement == InputRequirement::Defaulted
            {
                InputRequirement::Defaulted
            } else {
                InputRequirement::Optional
            };
            left_field.presence = if left_field.presence == OutputPresence::Required
                || right_field.presence == OutputPresence::Required
            {
                OutputPresence::Required
            } else {
                OutputPresence::Optional
            };
            left_field.nullable &= right_field.nullable;
            left_field.from_default |= right_field.from_default;
            left_field.evidence.extend(right_field.evidence);
            left_field.evidence = dedupe_evidence(std::mem::take(&mut left_field.evidence));
        } else {
            output.fields.insert(name, right_field);
        }
    }
    output.add_evidence(source_evidence(format!("Zod {label} schema"), location));
    output.gaps = dedupe_gaps(output.gaps);
    output.evidence = dedupe_evidence(output.evidence);
    output
}

fn pipe_schema(location: Option<SourceLocation>, input: &Schema, output: &Schema) -> Schema {
    let names = input
        .fields
        .keys()
        .chain(output.fields.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut schema = Schema {
        recognized: input.recognized || output.recognized,
        has_dynamic_fields: input.has_dynamic_fields || output.has_dynamic_fields,
        gaps: [input.gaps.clone(), output.gaps.clone()].concat(),
        evidence: [input.evidence.clone(), output.evidence.clone()].concat(),
        ..Schema::default()
    };
    for name in names {
        let input_field = input.fields.get(&name);
        let output_field = output.fields.get(&name);
        let mut field = input_field
            .or(output_field)
            .cloned()
            .unwrap_or_else(|| Field::required(Vec::new()));
        if let Some(output_field) = output_field {
            field.presence = output_field.presence;
            field.nullable = output_field.nullable;
            field.from_default |= output_field.from_default;
            field.evidence.extend(output_field.evidence.clone());
        }
        field.evidence = dedupe_evidence(field.evidence);
        schema.fields.insert(name, field);
    }
    schema.add_evidence(source_evidence("Zod pipe schema".to_string(), location));
    schema.gaps = dedupe_gaps(schema.gaps);
    schema.evidence = dedupe_evidence(schema.evidence);
    schema
}

fn merge_fields(target: &mut BTreeMap<String, Field>, incoming: BTreeMap<String, Field>) {
    for (name, field) in incoming {
        target.insert(name, field);
    }
}

fn call_parts(call: NodeRef<'_>) -> Result<Option<(String, Option<NodeRef<'_>>)>, AdapterError> {
    let Some(callee) = call.expression()? else {
        return Ok(None);
    };
    let callee = unwrap(callee)?;
    match callee.kind()? {
        NodeKind::PropertyAccessExpression => Ok(property_access(callee)?),
        NodeKind::Identifier => Ok(Some((text(callee)?, None))),
        _ => Ok(None),
    }
}

fn property_access(
    expression: NodeRef<'_>,
) -> Result<Option<(String, Option<NodeRef<'_>>)>, AdapterError> {
    if expression.kind()? != NodeKind::PropertyAccessExpression {
        return Ok(None);
    }
    let Some(name) = expression.name()? else {
        return Ok(None);
    };
    Ok(Some((text(name)?, expression.expression()?)))
}

fn static_property_name(name: NodeRef<'_>) -> Result<Option<String>, AdapterError> {
    match name.kind()? {
        NodeKind::Identifier => Ok(Some(text(name)?)),
        NodeKind::StringLiteral
        | NodeKind::NumericLiteral
        | NodeKind::NoSubstitutionTemplateLiteral => Ok(Some(strip_quotes(&text(name)?))),
        NodeKind::ComputedPropertyName => {
            let Some(expression) = name.expression()? else {
                return Ok(None);
            };
            let expression = unwrap(expression)?;
            if matches!(
                expression.kind()?,
                NodeKind::StringLiteral
                    | NodeKind::NumericLiteral
                    | NodeKind::NoSubstitutionTemplateLiteral
            ) {
                Ok(Some(strip_quotes(&text(expression)?)))
            } else {
                Ok(None)
            }
        }
        _ => Ok(None),
    }
}

fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = *trimmed.as_bytes().last().unwrap_or(&0);
        if matches!((first, last), (b'\'', b'\'') | (b'"', b'"') | (b'`', b'`')) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn is_zod_namespace(node: NodeRef<'_>) -> bool {
    node.type_text()
        .ok()
        .flatten()
        .is_some_and(|type_text| type_text.to_ascii_lowercase().contains("zod"))
        || node
            .text()
            .ok()
            .flatten()
            .is_some_and(|name| name == "z" || name == "zod")
}

fn is_zod_type(node: NodeRef<'_>) -> Result<bool, AdapterError> {
    let type_text = node.type_text()?.unwrap_or_default();
    let lower = type_text.to_ascii_lowercase();
    Ok(lower.contains("zod") || lower.contains("$zod"))
}

fn is_table_type(node: NodeRef<'_>) -> Result<bool, AdapterError> {
    let type_text = node.type_text()?.unwrap_or_default();
    let lower = type_text.to_ascii_lowercase();
    Ok(lower.contains("table") || lower.contains("view"))
}

fn unwrap(node: NodeRef<'_>) -> Result<NodeRef<'_>, AdapterError> {
    Ok(node.unwrap_expression()?.unwrap_or(node))
}

fn text(node: NodeRef<'_>) -> Result<String, AdapterError> {
    Ok(node.text()?.unwrap_or_default())
}

fn unresolved_field(evidence: Vec<Evidence>, at: Option<SourceLocation>) -> FieldResult {
    FieldResult {
        field: Field::required(evidence),
        has_dynamic_fields: true,
        gaps: vec![Gap {
            kind: "unresolved-schema-field".to_string(),
            message: "Zod field schema could not be statically resolved.".to_string(),
            at,
        }],
    }
}

fn dynamic_gap(kind: &str, message: String, at: Option<SourceLocation>) -> Gap {
    Gap {
        kind: kind.to_string(),
        message,
        at,
    }
}

fn source_evidence(message: String, at: Option<SourceLocation>) -> Evidence {
    Evidence {
        kind: "source".to_string(),
        message,
        at,
        model_id: None,
        declaration: None,
    }
}

fn push_unique<T: PartialEq>(items: &mut Vec<T>, item: T) {
    if !items.contains(&item) {
        items.push(item);
    }
}

fn dedupe_evidence(items: Vec<Evidence>) -> Vec<Evidence> {
    let mut output = Vec::new();
    for item in items {
        push_unique(&mut output, item);
    }
    output
}

fn dedupe_gaps(items: Vec<Gap>) -> Vec<Gap> {
    let mut output = Vec::new();
    for item in items {
        push_unique(&mut output, item);
    }
    output
}
