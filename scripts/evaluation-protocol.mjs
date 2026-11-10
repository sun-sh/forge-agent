/** Deterministic cyclic counterbalancing: every arm occupies every position over N repetitions. */
export function evaluationSchedule(tasks, arms, repeat) {
  if (!Number.isInteger(repeat) || repeat < 1 || !tasks.length || !arms.length || new Set(arms).size !== arms.length) throw new Error('Invalid evaluation schedule');
  return Array.from({ length: repeat }, (_, iteration) => tasks.flatMap((task, index) => {
    const offset = (iteration + index) % arms.length;
    return arms.map((_, position) => ({ task, workflow: arms[(position + offset) % arms.length], run: iteration + 1, position: position + 1 }));
  })).flat();
}

/** Missing/invalid review is an abstention, never a true negative or an invented detection. */
export function reviewConfusion(results) {
  const total = results.length;
  const positive = results.filter((r) => r.expectedDefect === true), negative = results.filter((r) => r.expectedDefect === false);
  const detected = (r) => r.valid === true && r.blocking === true;
  const accepted = (r) => r.valid === true && r.blocking === false;
  const truePositives = positive.filter(detected).length, falseNegatives = positive.filter(accepted).length;
  const falsePositives = negative.filter(detected).length, trueNegatives = negative.filter(accepted).length;
  const abstentions = results.filter((r) => r.valid !== true).length;
  return { total, defective: positive.length, correct: negative.length, truePositives, falseNegatives, falsePositives, trueNegatives, abstentions,
    recall: positive.length ? truePositives / positive.length : null,
    precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
    falsePositiveRate: negative.length ? falsePositives / negative.length : null,
    coverage: total ? (total - abstentions) / total : null };
}
