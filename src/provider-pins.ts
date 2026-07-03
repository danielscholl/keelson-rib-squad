export interface ProviderRegistration {
  id: string;
  displayName?: string;
}

export interface ProviderPin {
  provider?: string;
  model?: string;
}

const NON_ASSIGNABLE_PROVIDER_IDS = new Set(["workflow", "stub"]);

export function assignableProviders(
  providers: readonly ProviderRegistration[],
): ProviderRegistration[] {
  return providers.filter((p) => p.id && !NON_ASSIGNABLE_PROVIDER_IDS.has(p.id));
}

export function validateProviderPin(
  subject: string,
  pin: ProviderPin,
  providers: readonly ProviderRegistration[] | undefined,
): { pin: ProviderPin; note?: string } {
  const provider = pin.provider?.trim();
  const model = pin.model?.trim();
  if (!provider) return { pin: {} };
  // Reserved ids are never assignable, registry or not — the static denylist
  // must hold even on an older harness without getProviders.
  if (NON_ASSIGNABLE_PROVIDER_IDS.has(provider)) {
    const dropped = model ? `provider/model "${provider}" / "${model}"` : `provider "${provider}"`;
    return {
      pin: {},
      note: `dropped ${dropped} for ${subject}: provider is not assignable to squad members`,
    };
  }
  if (providers === undefined) {
    return { pin: { provider, ...(model ? { model } : {}) } };
  }

  const allowed = new Set(assignableProviders(providers).map((p) => p.id));
  if (!allowed.has(provider)) {
    const dropped = model ? `provider/model "${provider}" / "${model}"` : `provider "${provider}"`;
    return {
      pin: {},
      note: `dropped ${dropped} for ${subject}: provider is not registered for squad members`,
    };
  }

  return { pin: { provider, ...(model ? { model } : {}) } };
}
