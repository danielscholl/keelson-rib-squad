export interface ProviderRegistration {
  id: string;
  displayName?: string;
}

export interface ProviderPin {
  provider?: string;
  model?: string;
}

export interface ProviderPinResult {
  pin: ProviderPin;
  // Phrased for the callers that NORMALIZE a rejected pin — the scan's output, an
  // authored member: they drop it and carry on, so "dropped …" is the honest verb.
  note?: string;
  // The same event with no verb, for the callers that REJECT instead. They write
  // nothing, so `note`'s wording would describe a drop that never happened.
  rejected?: { what: string; why: string };
}

const NON_ASSIGNABLE_PROVIDER_IDS = new Set(["workflow", "stub"]);

function reject(subject: string, provider: string, model: string | undefined, why: string) {
  const what = model ? `provider/model "${provider}" / "${model}"` : `provider "${provider}"`;
  return { pin: {}, note: `dropped ${what} for ${subject}: ${why}`, rejected: { what, why } };
}

export function assignableProviders(
  providers: readonly ProviderRegistration[],
): ProviderRegistration[] {
  return providers.filter((p) => p.id && !NON_ASSIGNABLE_PROVIDER_IDS.has(p.id));
}

export function validateProviderPin(
  subject: string,
  pin: ProviderPin,
  providers: readonly ProviderRegistration[] | undefined,
): ProviderPinResult {
  const provider = pin.provider?.trim();
  const model = pin.model?.trim();
  if (!provider) return { pin: {} };
  // Reserved ids are never assignable, registry or not — the static denylist
  // must hold even on an older harness without getProviders.
  if (NON_ASSIGNABLE_PROVIDER_IDS.has(provider)) {
    return reject(subject, provider, model, "provider is not assignable to squad members");
  }
  if (providers === undefined) {
    return { pin: { provider, ...(model ? { model } : {}) } };
  }

  const allowed = new Set(assignableProviders(providers).map((p) => p.id));
  if (!allowed.has(provider)) {
    return reject(subject, provider, model, "provider is not registered for squad members");
  }

  return { pin: { provider, ...(model ? { model } : {}) } };
}
