use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use verule_adapter_api::{
    ADAPTER_ABI_VERSION, Adapter, AdapterError, AdapterManifest, Context, Evidence,
    FactContribution, FactRequest, NodeKind,
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
            fact_type_ids: vec!["fixture.call-source".to_string()],
        }
    }

    fn extract<'a>(
        &self,
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
            .and_then(serde_json::Value::as_str);
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
}

verule_adapter_api::export_adapter!(ComplementFixtureAdapter);
