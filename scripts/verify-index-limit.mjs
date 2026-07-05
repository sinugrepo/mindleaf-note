// Empirical check: does IndexedDB + Dexie silently fail when storing
// a large base64 string in an INDEXED field?
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

class TestDB extends Dexie {
  constructor() {
    super('VerifyDB');
    // Same schema as src/db/db.ts (with content indexed) — exposed via global.
    this.version(1).stores({
      notes: 'id, parentId, title, content, order',
    });
  }
}

const db = new TestDB();

function makeBigDataURL(targetBytes) {
  // Construct a syntactically valid data URL of approx targetBytes in length.
  const prefix = 'data:image/png;base64,';
  const filler = 'A'.repeat(Math.max(0, targetBytes - prefix.length));
  return prefix + filler;
}

async function run() {
  await db.notes.clear();

  // Insert a small note first (this should always work).
  await db.notes.add({
    id: 'small',
    parentId: null,
    title: 'Small',
    content: '<p>tiny</p>',
    order: 1,
    isExpanded: false,
    createdAt: 1,
    updatedAt: 1,
  });

  console.log('---- Test a ~50KB base64 in INDEXED content field ----');
  const mediumContent = makeBigDataURL(50 * 1024);
  try {
    await db.notes.update('small', { content: mediumContent });
    console.log('  50KB: OK (stored)');
  } catch (e) {
    console.log('  50KB: FAILED —', e?.name, e?.message);
  }

  console.log('---- Test ~150KB base64 in INDEXED content field ----');
  const bigContent = makeBigDataURL(150 * 1024);
  try {
    await db.notes.update('small', { content: bigContent });
    console.log('  150KB: OK (stored)');
  } catch (e) {
    console.log('  150KB: FAILED —', e?.name, e?.message);
  }

  console.log('---- Test ~500KB base64 in INDEXED content field ----');
  const hugeContent = makeBigDataURL(500 * 1024);
  try {
    await db.notes.update('small', { content: hugeContent });
    console.log('  500KB: OK (stored)');
  } catch (e) {
    console.log('  500KB: FAILED —', e?.name, e?.message);
  }

  // Now test what happens when we DO NOT index 'content'.
  console.log('---- Same writes but with NON-indexed content field ----');
  await db.delete();
  class TestDB2 extends Dexie {
    constructor() {
      super('VerifyDB');
      this.version(1).stores({
        notes: 'id, parentId, order', // no content index
      });
    }
  }
  const db2 = new TestDB2();
  await db2.notes.add({
    id: 'small',
    parentId: null,
    title: 'Small',
    content: '<p>tiny</p>',
    order: 1,
    isExpanded: false,
    createdAt: 1,
    updatedAt: 1,
  });

  for (const size of [50 * 1024, 150 * 1024, 500 * 1024, 1024 * 1024]) {
    try {
      const c = makeBigDataURL(size);
      await db2.notes.update('small', { content: c });
      const row = await db2.notes.get('small');
      const stored = (row?.content ?? '').length;
      console.log(`  ${size}B: OK (stored ${stored}B)`);
    } catch (e) {
      console.log(`  ${size}B: FAILED —`, e?.name, e?.message);
    }
  }
}

run().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
