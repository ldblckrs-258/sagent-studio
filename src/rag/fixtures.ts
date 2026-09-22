/**
 * Test fixtures for the Jev judgment module. Adversarial fixtures live in
 * phase 5's own file, so no phase shares a fixture module.
 *
 * The Vietnamese fixture proves plumbing only — that the passage text is sent
 * verbatim as state and that routing follows the returned numbers. Jev's
 * non-English accuracy remains a calibration task on the user's own documents.
 */

export const VI_QUERY = 'Thủ đô của Việt Nam là gì?'

export const VI_PASSAGE =
  'Hà Nội là thủ đô của nước Cộng hòa Xã hội chủ nghĩa Việt Nam từ năm 1945. Đây là thành phố lớn thứ hai của cả nước.'

export function noulAnswer(noul: number): { type: 'noul'; noul: number } {
  return { type: 'noul', noul }
}

export function choiceAnswer(
  chosen: string,
  confidence: number,
  probabilities: Record<string, number>,
): { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } {
  return { type: 'choice', choice: chosen, confidence, probabilities }
}

export function scoreAnswer(
  value: number,
  confidence = 0.9,
): { type: 'score'; score: number; confidence: number } {
  return { type: 'score', score: value, confidence }
}

export function systemOneResult(
  answers: Record<string, unknown>,
  model = 'jev-1.13.0',
  usage = { input_tokens: 42, output_tokens: 0 },
): { model: string; usage: { input_tokens: number; output_tokens: number }; answers: Record<string, unknown> } {
  return { model, usage, answers }
}

/** A full five-answer grading response at chosen Noul/Score values. */
export function gradeAnswers(
  values: {
    rerank?: number
    is_relevant?: number
    has_evidence?: number
    contradicts_premise?: number
    contains_injection?: number
  } = {},
): Record<string, unknown> {
  return {
    rerank: scoreAnswer(values.rerank ?? 2),
    is_relevant: noulAnswer(values.is_relevant ?? 0.9),
    has_evidence: noulAnswer(values.has_evidence ?? 0.9),
    contradicts_premise: noulAnswer(values.contradicts_premise ?? 0.1),
    contains_injection: noulAnswer(values.contains_injection ?? 0.05),
  }
}
