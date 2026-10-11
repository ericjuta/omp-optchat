/**
 * A scripted judge for the System One gates: each call's answers come from `reply`. No model, no network.
 * `requests` records every request, so a test can prove exactly what the judge was shown.
 */
import type {
  Answer,
  ChoiceAnswer,
  Judge,
  JudgeOptions,
  JudgmentRequest,
  JudgmentResult,
  NoulAnswer,
  Questions,
  ScoreAnswer,
  Usage,
} from "@oh-my-pi/pi-ai";

export type Reply = (
  request: JudgmentRequest<Questions>,
  signal: AbortSignal,
) => Record<string, Answer> | Promise<Record<string, Answer>>;

export interface FakeJudge extends Judge {
  readonly requests: JudgmentRequest<Questions>[];
}

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function fakeJudge(reply: Reply): FakeJudge {
  const requests: JudgmentRequest<Questions>[] = [];
  return {
    label: "fake/judge",
    requests,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
      requests.push(request as JudgmentRequest<Questions>);
      const answers = await reply(request as JudgmentRequest<Questions>, options?.signal ?? new AbortController().signal);
      return { api: "fake", provider: "fake", model: "fake", answers, usage: USAGE } as JudgmentResult<Q>;
    },
  };
}

export const noul = (p: number): NoulAnswer => ({ type: "noul", noul: p });

export const choice = (picked: string, probabilities: Record<string, number>): ChoiceAnswer<string> => ({
  type: "choice",
  choice: picked,
  probabilities,
  confidence: 1,
});

export const score = (value: number): ScoreAnswer => ({
  type: "score",
  score: value,
  probabilities: {},
  confidence: 1,
});
