use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use verule_adapter_api::{
    ADAPTER_ABI_VERSION, Adapter, AdapterError, AdapterManifest, Context, Evidence,
    FactContribution, FactRequest, NodeKind,
};

static INVOCATIONS: AtomicUsize = AtomicUsize::new(0);

const FIXTURE_ABI_VERSION: u32 = if cfg!(feature = "wrong-abi") {
    ADAPTER_ABI_VERSION + 1
} else {
    ADAPTER_ABI_VERSION
};

#[derive(Default)]
struct ThirdPartyFixtureAdapter;

impl Adapter for ThirdPartyFixtureAdapter {
    fn manifest(&self) -> AdapterManifest {
        AdapterManifest {
            abi_version: FIXTURE_ABI_VERSION,
            id: "third-party-fixture".to_string(),
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
            let location = call.location()?;
            let mut contribution = FactContribution::new(
                *call,
                json!({
                    "text": text,
                    "input": supplemental_input.clone(),
                    "invocation": invocation,
                }),
            );
            if let Some(at) = location {
                contribution.evidence.push(Evidence {
                    kind: "source".to_string(),
                    message: "Fixture adapter read this call from the active snapshot.".to_string(),
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

verule_adapter_api::export_adapter!(ThirdPartyFixtureAdapter);
