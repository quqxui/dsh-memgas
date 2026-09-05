export type RetrievalMode = 'lite' | 'hybrid' | 'memgas'

export interface ChannelSetting {
  enabled: boolean
  weight: number
}

export interface RetrievalProfile {
  mode: RetrievalMode
  /** Share of the final slots reserved for baseline channels. */
  baselineFloor: number
  channels: {
    lexical: ChannelSetting
    dense: ChannelSetting
    granularity: ChannelSetting
    graph: ChannelSetting
  }
}

export type RetrievalOverrides = {
  baselineFloor?: number
  channels?: Partial<Record<keyof RetrievalProfile['channels'], Partial<ChannelSetting>>>
}

const PROFILES: Record<RetrievalMode, RetrievalProfile> = {
  lite: {
    mode: 'lite',
    baselineFloor: 1,
    channels: {
      lexical: { enabled: true, weight: 1 },
      dense: { enabled: true, weight: 1 },
      granularity: { enabled: false, weight: 0 },
      graph: { enabled: false, weight: 0 },
    },
  },
  hybrid: {
    mode: 'hybrid',
    baselineFloor: 0.5,
    channels: {
      lexical: { enabled: true, weight: 1 },
      dense: { enabled: true, weight: 1 },
      granularity: { enabled: true, weight: 0.8 },
      graph: { enabled: true, weight: 0.6 },
    },
  },
  memgas: {
    mode: 'memgas',
    baselineFloor: 0.25,
    channels: {
      lexical: { enabled: true, weight: 1 },
      dense: { enabled: true, weight: 1 },
      granularity: { enabled: true, weight: 1.2 },
      graph: { enabled: true, weight: 1 },
    },
  },
}

/** Mode defaults with user overrides merged per channel. */
export function retrievalProfile(mode: RetrievalMode, overrides: RetrievalOverrides = {}): RetrievalProfile {
  const base = PROFILES[mode]
  const channels = { ...base.channels }
  for (const [name, override] of Object.entries(overrides.channels ?? {})) {
    const key = name as keyof RetrievalProfile['channels']
    if (!channels[key] || !override) continue
    channels[key] = { ...channels[key], ...override }
  }
  return {
    mode,
    baselineFloor: overrides.baselineFloor ?? base.baselineFloor,
    channels,
  }
}
