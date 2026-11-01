// Optimization categories: taxonomy integrity (every subcategory has
// a label and a strategy label, and belongs to exactly one big
// category). Baselines carry no prime scenario anymore — the factor
// model replaced the baseline-scenario mapping entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_OPT_CATEGORIES, planOptCategory, planOptSubcategory,
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

