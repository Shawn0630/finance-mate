// Optimization categories + baseline-scenario mapping: taxonomy
// integrity (every subcategory has a label and a strategy label, and
// belongs to exactly one big category) and the planBaselineScenario
// conversion (valid direction passes through with a neutral default
// stance; an invalid direction yields null, so the caller keeps the
// project base scenario instead of projecting under garbage).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_OPT_CATEGORIES, planOptCategory, planOptSubcategory, planBaselineScenario,
} from '../src/planning.js';

test('taxonomy: five big categories with the settled subcategory sets', () => {
  const keys = Object.keys(PLAN_OPT_CATEGORIES);
  assert.deepEqual(keys, ['property', 'investment', 'earning', 'saving', 'tax_saving']);
  assert.deepEqual(Object.keys(PLAN_OPT_CATEGORIES.property.subcategories), ['interest_rate', 'refinance']);
  assert.deepEqual(Object.keys(PLAN_OPT_CATEGORIES.investment.subcategories), ['gic', 'stock', 'etf']);
  assert.deepEqual(Object.keys(PLAN_OPT_CATEGORIES.earning.subcategories), ['salary', 'rental']);
  assert.deepEqual(Object.keys(PLAN_OPT_CATEGORIES.saving.subcategories), ['spending_analysis']);
  assert.deepEqual(Object.keys(PLAN_OPT_CATEGORIES.tax_saving.subcategories), ['tax_analysis']);
});

test('taxonomy: every category and subcategory carries label + strategyLabel, no subcategory repeats', () => {
  const seenSubs = new Map();
  for (const cat of Object.values(PLAN_OPT_CATEGORIES)) {
    assert.ok(cat.label, `${cat.key} label`);
    assert.ok(cat.entityType, `${cat.key} entityType`);
    for (const sub of Object.values(cat.subcategories)) {
      assert.ok(sub.label, `${sub.key} label`);
      assert.ok(sub.strategyLabel, `${sub.key} strategyLabel`);
      assert.ok(!seenSubs.has(sub.key), `${sub.key} belongs to two categories`);
      seenSubs.set(sub.key, cat.key);
      assert.equal(planOptCategory(cat.key).key, cat.key);
      assert.equal(planOptSubcategory(cat.key, sub.key).key, sub.key);
    }
  }
  assert.equal(planOptCategory('nope'), null);
  assert.equal(planOptSubcategory('property', 'nope'), null);
  assert.equal(planOptSubcategory('nope', 'interest_rate'), null);
});

test('planBaselineScenario: valid direction passes through, stance defaults to neutral', () => {
  const out = planBaselineScenario({
    description: 'Prime rises',
    primeScenario: { name: 'Up path', direction: 'up', stance: 'pessimistic', magnitude: 1, steps: [{ date: '2027-01-01', rate: 5.5 }] },
    stockReference: 'current-plan',
  });
  assert.equal(out.direction, 'up');
  assert.equal(out.stance, 'pessimistic');
  assert.equal(out.magnitude, 1);
  assert.deepEqual(out.steps, [{ date: '2027-01-01', rate: 5.5 }]);
  const flat = planBaselineScenario({ primeScenario: { name: 'Flat', direction: 'flat' } });
  assert.equal(flat.direction, 'flat');
  assert.equal(flat.stance, 'neutral');
  assert.equal(flat.magnitude, null);
  assert.equal(flat.steps, null);
});

test('planBaselineScenario: null or invalid prime scenario yields null', () => {
  assert.equal(planBaselineScenario({ description: 'No prime path' }), null);
  assert.equal(planBaselineScenario({ primeScenario: null }), null);
  assert.equal(planBaselineScenario({ primeScenario: { name: 'Bad', direction: 'sideways' } }), null);
  assert.equal(planBaselineScenario(null), null);
});
