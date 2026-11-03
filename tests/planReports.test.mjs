// Report + template round: scenario pinning validation and AI chart
// method validation are pure helpers in src/planning.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportScenarioIds, validateAiChartMethods, validateReportDefinition,
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
