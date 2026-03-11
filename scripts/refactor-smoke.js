#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadPluginClass() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
  const factory = new Function('AppPlugin', `${source}; return Plugin;`);
  return factory(class AppPlugin {});
}

function makeDate(value) {
  return value ? new Date(value) : null;
}

function makeProperty(name, value) {
  return {
    name,
    value,
    text() {
      return typeof value === 'string' ? value : '';
    },
    choice() {
      return null;
    }
  };
}

function makeRecord({ guid, name, updatedAt, createdAt, properties = [], journal = false }) {
  return {
    guid,
    getName() {
      return name;
    },
    getUpdatedAt() {
      return updatedAt || null;
    },
    getCreatedAt() {
      return createdAt || null;
    },
    getAllProperties() {
      return properties;
    },
    getJournalDetails() {
      return journal ? { date: '2026-03-11' } : null;
    }
  };
}

function makeLine({ guid, record, segments = [], type = 'text', createdAt, updatedAt, parentGuid = null }) {
  return {
    guid,
    record,
    segments,
    type,
    parent_guid: parentGuid,
    getCreatedAt() {
      return createdAt || null;
    },
    getUpdatedAt() {
      return updatedAt || null;
    }
  };
}

function makePlugin() {
  const Plugin = loadPluginClass();
  const plugin = new Plugin();

  plugin._defaultSortBy = 'page_last_edited';
  plugin._defaultSortDir = 'desc';
  plugin._defaultFilterPreset = 'all';
  plugin._recentActivityWindowMs = 7 * 24 * 60 * 60 * 1000;
  plugin._queryBuiltInKeys = [
    'created_at', 'modified_at', 'created_by', 'modified_by', 'text', 'type', 'date',
    'due', 'time', 'mention', 'scheduled', 'hashtag', 'link', 'collection', 'guid',
    'pguid', 'rguid', 'backref', 'linkto'
  ];

  const recordsByGuid = new Map();
  const users = [
    {
      guid: 'user-1',
      getDisplayName() {
        return 'Harpreet';
      }
    }
  ];

  plugin.data = {
    getRecord(guid) {
      return recordsByGuid.get(guid) || null;
    },
    getActiveUsers() {
      return users;
    }
  };

  plugin.__recordsByGuid = recordsByGuid;
  return plugin;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('property candidate parsing supports record tuples and nested objects', () => {
  const plugin = makePlugin();
  const prop = makeProperty('Entity', [
    ['record', 'target-guid'],
    { value: ['records', [{ guid: 'other-guid' }, { targetGuid: 'nested-guid' }]] },
    '{"ignored":true}'
  ]);

  const values = plugin.getPropertyCandidateValues(prop);
  assert.equal(values.includes('target-guid'), true);
  assert.equal(values.includes('other-guid'), true);
  assert.equal(values.includes('nested-guid'), true);
  assert.equal(plugin.propertyReferencesGuid(prop, 'target-guid'), true);
  assert.equal(plugin.propertyReferencesGuid(prop, 'missing-guid'), false);
});

test('property backlink grouping dedupes records and sorts groups by property name', () => {
  const plugin = makePlugin();
  const targetGuid = 'target-guid';
  const alpha = makeRecord({
    guid: 'record-alpha',
    name: 'Alpha',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [
      makeProperty('Project', ['record', targetGuid]),
      makeProperty('Entity', ['record', targetGuid])
    ]
  });
  const beta = makeRecord({
    guid: 'record-beta',
    name: 'Beta',
    updatedAt: makeDate('2026-03-11T16:00:00Z'),
    properties: [makeProperty('Project', ['record', targetGuid])]
  });

  const groups = plugin.buildPropertyBacklinkGroupsFromRecords([alpha, beta, beta], targetGuid, { showSelf: false });
  assert.deepEqual(groups.map((group) => group.propertyName), ['Entity', 'Project']);
  assert.deepEqual(groups[1].records.map((record) => record.guid), ['record-beta', 'record-alpha']);
});

test('linked and unlinked grouping preserves source grouping rules', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note', updatedAt: makeDate('2026-03-10T09:00:00Z') });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note', updatedAt: makeDate('2026-03-11T09:00:00Z') });

  const linkedOlder = makeLine({
    guid: 'line-1',
    record: source,
    createdAt: makeDate('2026-03-10T08:00:00Z'),
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const linkedNewer = makeLine({
    guid: 'line-2',
    record: source,
    createdAt: makeDate('2026-03-10T09:00:00Z'),
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const mentionOnly = makeLine({
    guid: 'line-3',
    record: source,
    createdAt: makeDate('2026-03-10T10:00:00Z'),
    segments: [{ type: 'text', text: 'Target Note shows up here without a record link.' }]
  });
  const mentionAndLink = makeLine({
    guid: 'line-4',
    record: source,
    createdAt: makeDate('2026-03-10T11:00:00Z'),
    segments: [
      { type: 'text', text: 'Target Note also appears with a real link ' },
      { type: 'ref', text: { guid: target.guid, title: target.getName() } }
    ]
  });

  const linkedGroups = plugin.groupBacklinkLines([linkedNewer, linkedOlder], target.guid, { showSelf: false });
  assert.deepEqual(linkedGroups[0].lines.map((line) => line.guid), ['line-1', 'line-2']);

  const unlinkedGroups = plugin.groupUnlinkedReferenceLines(
    [linkedOlder, mentionOnly, mentionAndLink],
    linkedGroups,
    target.guid,
    target.getName(),
    { showSelf: false }
  );
  assert.deepEqual(unlinkedGroups[0].lines.map((line) => line.guid), ['line-3']);
});

test('sort metrics support reference-count and reference-activity ordering', () => {
  const plugin = makePlugin();
  const alpha = makeRecord({
    guid: 'record-alpha',
    name: 'Alpha',
    updatedAt: makeDate('2026-03-09T09:00:00Z'),
    createdAt: makeDate('2026-03-01T09:00:00Z')
  });
  const beta = makeRecord({
    guid: 'record-beta',
    name: 'Beta',
    updatedAt: makeDate('2026-03-08T09:00:00Z'),
    createdAt: makeDate('2026-03-02T09:00:00Z')
  });

  const propertyGroups = [
    { propertyName: 'Entity', records: [alpha] }
  ];
  const linkedGroups = [
    {
      record: beta,
      lines: [
        makeLine({ guid: 'line-a', record: beta, updatedAt: makeDate('2026-03-11T10:00:00Z') }),
        makeLine({ guid: 'line-b', record: beta, updatedAt: makeDate('2026-03-11T12:00:00Z') })
      ]
    }
  ];

  const sortMetrics = plugin.computeRecordSortMetrics(propertyGroups, linkedGroups);
  assert.equal(sortMetrics.referenceCountByGuid.get(beta.guid), 2);
  assert.equal(sortMetrics.referenceActivityByGuid.get(beta.guid), makeDate('2026-03-11T12:00:00Z').getTime());

  const byCount = plugin.compareRecordsForSort(alpha, beta, { sortBy: 'reference_count', sortDir: 'desc' }, sortMetrics);
  const byActivity = plugin.compareRecordsForSort(alpha, beta, { sortBy: 'reference_activity', sortDir: 'desc' }, sortMetrics);
  assert.equal(byCount > 0, true);
  assert.equal(byActivity > 0, true);
});

test('document-order builder keeps children directly after their parent', () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-guid', name: 'Ordered Note' });
  const items = [
    { guid: 'child-b', parent_guid: 'parent-b' },
    { guid: 'parent-a', parent_guid: record.guid },
    { guid: 'child-a', parent_guid: 'parent-a' },
    { guid: 'parent-b', parent_guid: record.guid }
  ];

  const ordered = plugin.buildRecordDocumentOrder(record, items);
  assert.deepEqual(ordered.map((item) => item.guid), ['parent-a', 'child-a', 'parent-b', 'child-b']);
});

test('segment helpers keep plain text, mentions, refs, and datetimes readable', () => {
  const plugin = makePlugin();
  const linkedRecord = makeRecord({ guid: 'linked-guid', name: 'Linked Record' });
  plugin.__recordsByGuid.set(linkedRecord.guid, linkedRecord);

  const text = plugin.segmentsToPlainText([
    { type: 'text', text: 'Hello ' },
    { type: 'mention', text: 'user-1' },
    { type: 'text', text: ' meet ' },
    { type: 'ref', text: { guid: linkedRecord.guid } },
    { type: 'text', text: ' on ' },
    { type: 'datetime', text: { d: '20260311' } }
  ]);

  assert.equal(text, 'Hello @Harpreet meet Linked Record on 2026-03-11');
});

test('query-mode helpers distinguish plain text from Thymer query drafts', () => {
  const plugin = makePlugin();
  assert.equal(plugin.getSearchMode('plain text'), 'text');
  assert.equal(plugin.getSearchMode('@task'), 'query');
  assert.equal(plugin.isIncompleteQueryDraft('@Sources.'), true);
  assert.equal(plugin.isIncompleteQueryDraft('@modified_at > "2026-03-01"'), false);
});

let passed = 0;
for (const { name, fn } of tests) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

console.log(`\nrefactor smoke passed (${passed} checks)`);
