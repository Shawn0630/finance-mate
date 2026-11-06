// Report + template round: scenario pinning validation and AI chart
// method validation are pure helpers in src/planning.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportScenarioIds, validateAiChartMethods, validateReportDefinition,
  validateAiReportBaselineKind, validateAiReportChartSeries, aiReportPrompt, aiReportHistoryLines,
} from '../src/planning.js';

test('report scenario pin: pinned ids must belong to the project', () => {
  assert.equal(validateReportScenarioIds([1, 2], [1, 2, 3]), null);
  assert.match(validateReportScenarioIds([9], [1, 2]), /not in this project/);
  assert.match(validateReportScenarioIds('1', [1]), /must be an array/);
  assert.equal(validateReportScenarioIds([1, 1], [1, 2]), null);
});

test('report scenario pin: empty pin rejected when scenarios exist, flat world allowed when none exist', () => {
  assert.match(validateReportScenarioIds([], [1, 2]), /pin at least one scenario/);
  assert.equal(validateReportScenarioIds([], []), null);
  assert.equal(validateReportScenarioIds([], null), null);
});

test('AI chart methods: every chart needs a non-empty method', () => {
  assert.deepEqual(validateAiChartMethods([
    { template: 'time_line', title: 'Balance', method: 'Monthly outstanding principal from the engine projection.' },
  ]), []);
  const errs = validateAiChartMethods([
    { template: 'time_line', title: 'Balance' },
    { template: 'metric_cards', title: 'Headlines', method: '  ' },
    { template: 'yearly_bars', title: 'Year-end', method: 'Year-end balances.' },
  ]);
  assert.equal(errs.length, 2);
  assert.match(errs[0], /Balance/);
  assert.match(errs[1], /Headlines/);
  assert.deepEqual(validateAiChartMethods('nope'), ['charts must be an array']);
});

test('report definition edit: structural validation only', () => {
  assert.deepEqual(validateReportDefinition({ charts: [{ template: 'time_line', title: 'Balance' }] }), []);
  assert.deepEqual(validateReportDefinition({}), []);
  assert.deepEqual(validateReportDefinition({ charts: [] }), []);
  assert.match(validateReportDefinition(null).join('; '), /must be an object/);
  assert.match(validateReportDefinition([]).join('; '), /must be an object/);
  assert.match(validateReportDefinition({ charts: {} }).join('; '), /must be an array/);
  assert.match(validateReportDefinition({ charts: [{ template: 'time_line' }] }).join('; '), /template and a title/);
  assert.match(validateReportDefinition({ charts: [{ title: 'No template' }] }).join('; '), /template and a title/);
  // Unknown templates pass structural validation (the renderer
  // tolerates them as "Not rendered") so a delete is never blocked.
  assert.deepEqual(validateReportDefinition({ charts: [{ template: 'nope', title: 'Legacy' }] }), []);
});

test('baseline kind: a stock fan_band is allowed on a cash-pool baseline, a mortgage fan is not', () => {
  const stockFan = [{ template: 'fan_band', title: 'Stock volatility fan', series: ['stock_value'] }];
  assert.deepEqual(validateAiReportBaselineKind(stockFan, 'pool'), []);
  // No series defaults to the stock fan on a pool template.
  assert.deepEqual(validateAiReportBaselineKind([{ template: 'fan_band', title: 'Fan' }], 'pool'), []);
  const mortFan = [{ template: 'fan_band', title: 'Fan', series: ['mortgage_balance'] }];
  assert.ok(validateAiReportBaselineKind(mortFan, 'pool').some((e) => /mortgage series/.test(e)));
  // The mortgage fan stays allowed on a property baseline.
  assert.deepEqual(validateAiReportBaselineKind(mortFan, 'property'), []);
  // Other pool bans are unchanged.
  const mortLine = [{ template: 'time_line', title: 'Balance', series: ['mortgage_balance'] }];
  assert.ok(validateAiReportBaselineKind(mortLine, 'pool').some((e) => /mortgage_balance/.test(e)));
  const poolLine = [{ template: 'time_line', title: 'Cash pool', series: ['pool_balance', 'stock_value'] }];
  assert.deepEqual(validateAiReportBaselineKind(poolLine, 'pool'), []);
});

test('report chart series: fan_band binds to stock_value or mortgage_balance only', () => {
  assert.deepEqual(validateAiReportChartSeries([{ template: 'fan_band', title: 'Fan', series: ['stock_value'] }]), []);
  assert.deepEqual(validateAiReportChartSeries([{ template: 'fan_band', title: 'Fan', series: ['mortgage_balance'] }]), []);
  assert.ok(validateAiReportChartSeries([{ template: 'fan_band', title: 'Fan', series: ['cost'] }]).some((e) => /cannot render series/.test(e)));
});

test('AI report prompt: pool kindLine offers the stock fan and forbids the mortgage fan', () => {
  const pool = aiReportPrompt({ strategies: [], mortgagedCount: 0, holdingCount: 1, text: 'x', baselineKind: 'pool' });
  assert.match(pool, /fan_band for a STOCK volatility fan only/);
  assert.match(pool, /never use fan_band for a mortgage series/);
  assert.match(pool, /you only pick the chart, never the numbers/);
  const prop = aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 0, text: 'x', baselineKind: 'property' });
  assert.doesNotMatch(prop, /never use fan_band/);
  assert.match(prop, /fan_band renders stock_value/);
});

test('AI report follow-up history: lines built from existing charts + applied turns', () => {
  assert.deepEqual(aiReportHistoryLines({}), []);
  assert.deepEqual(aiReportHistoryLines({ existingTitles: ['Balance path'] }), ['Charts already in this report: Balance path']);
  assert.deepEqual(
    aiReportHistoryLines({ existingTitles: ['Balance path'], turns: [{ userText: 'Add a yearly chart', addedTitles: ['Year-end balance'] }] }),
    ['Charts already in this report: Balance path', 'You asked: Add a yearly chart', 'Added charts: Year-end balance'],
  );
  // A turn not yet Applied contributes its question only, never
  // invented added titles.
  assert.deepEqual(
    aiReportHistoryLines({ turns: [{ userText: 'Add a fan', addedTitles: [] }] }),
    ['You asked: Add a fan'],
  );
  assert.deepEqual(aiReportHistoryLines({ existingTitles: ['  ', null, 7] }), []);
});

test('AI report prompt: history block present only when history is given', () => {
  const withHistory = aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 0, text: 'Add a yearly chart', history: ['Charts already in this report: Balance path', 'You asked: Add a yearly chart'] });
  assert.match(withHistory, /Conversation so far/);
  assert.match(withHistory, /Charts already in this report: Balance path/);
  assert.match(withHistory, /Do not propose a chart that is already in the report/);
  assert.match(withHistory, /User request: Add a yearly chart/);
  const without = aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 0, text: 'x' });
  assert.doesNotMatch(without, /Conversation so far/);
  const empty = aiReportPrompt({ strategies: [], mortgagedCount: 1, holdingCount: 0, text: 'x', history: [] });
  assert.doesNotMatch(empty, /Conversation so far/);
});
