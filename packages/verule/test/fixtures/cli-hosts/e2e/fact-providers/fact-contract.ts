import { defineFactType, type Evidence } from "@boringparts/verule";

export type FieldRequirement = {
  readonly requirement: "required" | "optional";
  readonly evidence?: readonly Evidence[];
};

export type InputSpecValue = {
  readonly fields: Record<string, FieldRequirement>;
  readonly required: readonly string[];
};

export const InputSpecFact = defineFactType<"call", undefined, InputSpecValue>({
  id: "e2e.validator.input-spec",
  subjectKind: "call",
  merge: (existing, incoming) => {
    const fields: Record<string, FieldRequirement> = {
      ...existing.value.fields,
    };
    for (const [k, v] of Object.entries(incoming.value.fields)) {
      const prev = fields[k];
      if (!prev) {
        fields[k] = v;
        continue;
      }
      if (prev.requirement !== v.requirement) {
        return {
          ok: false,
          conflict: {
            message: `Conflicting requirement for "${k}": ${prev.requirement} vs ${v.requirement}`,
            existingConclusion: `${k}=${prev.requirement}`,
            incomingConclusion: `${k}=${v.requirement}`,
            existingEvidence: prev.evidence ?? existing.evidence,
            incomingEvidence: v.evidence ?? incoming.evidence,
          },
        };
      }
    }
    const required = Object.keys(fields)
      .filter((k) => fields[k].requirement === "required")
      .toSorted();
    return { ok: true, value: { fields, required } };
  },
});
