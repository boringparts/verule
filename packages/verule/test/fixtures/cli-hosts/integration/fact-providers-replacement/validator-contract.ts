import { defineFactType, type Evidence } from "@boringparts/verule";

export type FieldRequirement = "required" | "optional";

export type ValidatorFieldInfo = {
  readonly requirement: FieldRequirement;
  readonly evidence?: readonly Evidence[];
};

export type ValidatorContractValue = {
  readonly schemaName?: string;
  readonly fields: Readonly<Record<string, ValidatorFieldInfo>>;
  readonly requiredFields: readonly string[];
  readonly hasDynamicFields: boolean;
};

export const ValidatorContractFact = defineFactType<
  "call",
  unknown,
  ValidatorContractValue
>({
  id: "thirdparty.validator.contract",
  description: "Input field requirements extracted by any validator provider.",
  subjectKind: "call",
  merge: (existing, incoming) => {
    const mergedFields: Record<string, ValidatorFieldInfo> = {
      ...existing.value.fields,
    };
    for (const [name, incomingField] of Object.entries(incoming.value.fields)) {
      const existingField = mergedFields[name];
      if (!existingField) {
        mergedFields[name] = incomingField;
        continue;
      }
      if (existingField.requirement !== incomingField.requirement) {
        return {
          ok: false,
          conflict: {
            message: `Conflicting requirement for "${name}": ${existingField.requirement} vs ${incomingField.requirement}`,
            existingConclusion: `${name}=${existingField.requirement}`,
            incomingConclusion: `${name}=${incomingField.requirement}`,
            ...(existingField.evidence !== undefined
              ? { existingEvidence: existingField.evidence }
              : { existingEvidence: existing.evidence }),
            ...(incomingField.evidence !== undefined
              ? { incomingEvidence: incomingField.evidence }
              : { incomingEvidence: incoming.evidence }),
          },
        };
      }
    }
    const requiredFields = Object.keys(mergedFields)
      .filter((k) => mergedFields[k]?.requirement === "required")
      .toSorted();
    const schemaName = existing.value.schemaName ?? incoming.value.schemaName;
    return {
      ok: true,
      value: {
        ...(schemaName !== undefined ? { schemaName } : {}),
        fields: mergedFields,
        requiredFields,
        hasDynamicFields: Boolean(
          existing.value.hasDynamicFields || incoming.value.hasDynamicFields,
        ),
      },
    };
  },
});
