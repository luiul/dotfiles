// Rolling per-session baseline used to decide when writing is *degrading*,
// not whether it is clean against some fixed bar. This is the piece that
// makes the extension lazy: a session that has always been a bit wordy
// never gets flagged, but a session that starts clean and drifts does.

export const DEFAULT_WARMUP_COUNT = 4;
export const DEFAULT_DEGRADE_RATIO = 2;
export const DEFAULT_DEGRADE_ABS = 4;
export const DEFAULT_STREAK_THRESHOLD = 3;
export const DEFAULT_EWMA_ALPHA = 0.3;
export const DEFAULT_DEGRADING_ALPHA = DEFAULT_EWMA_ALPHA / 4;
export const DEFAULT_MAX_INTERVENTIONS = 3;

export interface BaselineState {
	samples: readonly number[];
	ewma: number | null;
	streak: number;
	armed: boolean;
	interventionCount: number;
}

export interface BaselineOptions {
	warmupCount?: number;
	degradeRatio?: number;
	degradeAbs?: number;
	streakThreshold?: number;
	alpha?: number;
	degradingAlpha?: number;
	cooldown?: boolean;
	maxInterventions?: number;
}

export interface BaselineUpdate {
	state: BaselineState;
	baseline: number | null;
	degrading: boolean;
	shouldIntervene: boolean;
	recovered: boolean;
}

export function createBaselineState(): BaselineState {
	return { samples: [], ewma: null, streak: 0, armed: false, interventionCount: 0 };
}

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Pure update: given the current state and a new score, returns the next
 * state plus the decision for this sample. Never mutates `state`. */
export function updateBaseline(state: BaselineState, score: number, options: BaselineOptions = {}): BaselineUpdate {
	const warmupCount = options.warmupCount ?? DEFAULT_WARMUP_COUNT;
	const degradeRatio = options.degradeRatio ?? DEFAULT_DEGRADE_RATIO;
	const degradeAbs = options.degradeAbs ?? DEFAULT_DEGRADE_ABS;
	const streakThreshold = options.streakThreshold ?? DEFAULT_STREAK_THRESHOLD;
	const alpha = options.alpha ?? DEFAULT_EWMA_ALPHA;
	const degradingAlpha = options.degradingAlpha ?? DEFAULT_DEGRADING_ALPHA;
	const cooldown = options.cooldown ?? true;
	const maxInterventions = options.maxInterventions ?? DEFAULT_MAX_INTERVENTIONS;

	if (state.samples.length < warmupCount) {
		const samples = [...state.samples, score];
		return {
			state: { ...state, samples, ewma: mean(samples), streak: 0, armed: false },
			baseline: mean(samples),
			degrading: false,
			shouldIntervene: false,
			recovered: false,
		};
	}

	const baseline = state.ewma ?? mean(state.samples);
	const degrading = score - baseline > degradeAbs || (baseline > 0 && score > baseline * degradeRatio);

	if (!degrading) {
		const nextEwma = baseline + alpha * (score - baseline);
		const recovered = state.armed;
		return {
			state: { ...state, samples: state.samples, ewma: nextEwma, streak: 0, armed: false },
			baseline,
			degrading: false,
			shouldIntervene: false,
			recovered,
		};
	}

	// A slow upward update lets a session that is consistently wordy settle at
	// its own level. Cross-session history still receives clean samples only.
	const nextEwma = baseline + degradingAlpha * (score - baseline);
	const streak = state.streak + 1;
	const underCap = maxInterventions < 0 || state.interventionCount < maxInterventions;
	const shouldIntervene =
		streak >= streakThreshold && underCap && (!cooldown || !state.armed);
	return {
		state: {
			...state,
			samples: state.samples,
			ewma: nextEwma,
			streak,
			armed: state.armed || shouldIntervene,
			interventionCount: state.interventionCount + (shouldIntervene ? 1 : 0),
		},
		baseline,
		degrading: true,
		shouldIntervene,
		recovered: false,
	};
}
