import { MODEL_TIER_META } from "../ai/model-tier";
import { Row, Select } from "../ui/primitives";
import { MODEL_TIERS } from "../vault/settings";
import type { ModelTier, Settings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import { SectionHeader } from "./SectionHeader";

function ModelTierRow({ settings, tier }: { settings: Settings; tier: ModelTier }) {
  const update = useVaultStore((s) => s.update);
  const providers = settings.providers;
  const selection = settings.modelTiers?.[tier] ?? {};
  const provider = providers.find((entry) => entry.id === selection.providerId);
  const meta = MODEL_TIER_META[tier];

  const pickProvider = (providerId: string) => {
    if (providerId === "") {
      void update({ modelTiers: { [tier]: { providerId: "", modelId: "" } } });
      return;
    }
    const next = providers.find((entry) => entry.id === providerId);
    void update({ modelTiers: { [tier]: { providerId, modelId: next?.defaultModel ?? "" } } });
  };

  return (
    <div className="border-t border-rule pt-2 first:border-t-0 first:pt-0">
      <p className="text-xs font-medium text-ink">
        {meta.label}
        <span className="ml-1 font-mono font-normal text-faint">{tier}</span>
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">{meta.blurb}</p>
      <Row label="Provider" hint="Leave unset to fall back to the conversation's model.">
        <Select
          size="sm"
          value={selection.providerId ?? ""}
          disabled={providers.length === 0}
          onChange={(event) => pickProvider(event.target.value)}
        >
          <option value="">Not set</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label || entry.id}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        label="Model"
        hint="Used for this tier."
        error={
          selection.providerId && provider && provider.models.length === 0
            ? "This provider has no models. Fetch or add them above."
            : undefined
        }
      >
        <Select
          size="sm"
          value={selection.modelId ?? ""}
          disabled={!provider || provider.models.length === 0}
          onChange={(event) =>
            void update({
              modelTiers: {
                [tier]: { providerId: selection.providerId ?? "", modelId: event.target.value },
              },
            })
          }
        >
          <option value="">Provider default</option>
          {(provider?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name ?? model.id}
            </option>
          ))}
        </Select>
      </Row>
    </div>
  );
}

/**
 * The four model tiers, one provider+model selection each. Spark names
 * conversations and rewrites document queries; Forge and Prime back delegated
 * agents; Oracle is only used when a delegation asks for it explicitly.
 */
export function ModelTiersPanel() {
  const settings = useVaultStore((s) => s.settings);
  if (!settings) return null;

  return (
    <section className="flex flex-col px-3 py-3">
      <SectionHeader
        title="Model tiers"
        description="Four tiers back delegated agents and lightweight background tasks. Spark names a new conversation and rewrites a user-sourced document search. A tier left unset falls back to the conversation's own model; Oracle is only used when a delegation asks for it explicitly."
      />
      <div className="mt-1">
        {MODEL_TIERS.map((tier) => (
          <ModelTierRow key={tier} settings={settings} tier={tier} />
        ))}
      </div>
    </section>
  );
}
