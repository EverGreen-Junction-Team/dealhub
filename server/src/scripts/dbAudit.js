// dbAudit.js — one-shot schema audit against the live database.
//
// Reads DATABASE_URL from .env (never from chat). Prints every table + view
// in the public schema with column list, RLS state, policies, and row count.
// Output shaped for easy diffing against James's spec.
//
// Usage (from server/ directory):
//   node src/scripts/dbAudit.js
//   node src/scripts/dbAudit.js --table vw_opportunity_flat
//   node src/scripts/dbAudit.js --tables > audit.txt        # tables only
//   node src/scripts/dbAudit.js --json > audit.json         # machine-readable

import 'dotenv/config';
import pg from 'pg';

function parseArgs(argv) {
  const args = { table: null, tablesOnly: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--table' && argv[i + 1]) args.table = argv[++i];
    else if (argv[i] === '--tables') args.tablesOnly = true;
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

async function fetchAll(client, query, params = []) {
  const { rows } = await client.query(query, params);
  return rows;
}

async function listRelations(client, tableFilter) {
  return fetchAll(client, `
    SELECT c.relname                                       AS name,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'matview'
             ELSE c.relkind::text
           END                                             AS kind,
           c.relrowsecurity                                AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','v','m')
       AND ($1::text IS NULL OR c.relname = $1)
     ORDER BY c.relkind, c.relname
  `, [tableFilter]);
}

async function fetchColumns(client, tableName) {
  return fetchAll(client, `
    SELECT column_name,
           data_type,
           is_nullable,
           column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position
  `, [tableName]);
}

async function fetchPrimaryKey(client, tableName) {
  return fetchAll(client, `
    SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
     WHERE tc.table_schema    = 'public'
       AND tc.table_name      = $1
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position
  `, [tableName]);
}

async function fetchForeignKeys(client, tableName) {
  return fetchAll(client, `
    SELECT tc.constraint_name,
           kcu.column_name,
           ccu.table_name  AS foreign_table,
           ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
     WHERE tc.table_schema    = 'public'
       AND tc.table_name      = $1
       AND tc.constraint_type = 'FOREIGN KEY'
     ORDER BY tc.constraint_name, kcu.ordinal_position
  `, [tableName]);
}

async function fetchIndexes(client, tableName) {
  return fetchAll(client, `
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname
  `, [tableName]);
}

async function fetchPolicies(client, tableName) {
  return fetchAll(client, `
    SELECT policyname, cmd, qual::text AS qual
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY policyname
  `, [tableName]);
}

async function fetchRowCount(client, relName, kind) {
  // Skip counts on views to avoid heavy scans — views can be aggregations.
  if (kind !== 'table') return null;
  try {
    const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM public."${relName}"`);
    return Number(rows[0].n);
  } catch (err) {
    return `error: ${err.message}`;
  }
}

async function auditRelation(client, rel) {
  const [columns, pk, fks, indexes, policies, rowCount] = await Promise.all([
    fetchColumns(client, rel.name),
    fetchPrimaryKey(client, rel.name),
    fetchForeignKeys(client, rel.name),
    fetchIndexes(client, rel.name),
    fetchPolicies(client, rel.name),
    fetchRowCount(client, rel.name, rel.kind)
  ]);
  return { ...rel, columns, pk, fks, indexes, policies, rowCount };
}

function renderText(all) {
  const lines = [];
  lines.push('='.repeat(80));
  lines.push(`SCHEMA AUDIT — public schema — ${new Date().toISOString()}`);
  lines.push(`${all.length} relations`);
  lines.push('='.repeat(80));
  lines.push('');

  // Summary index
  lines.push('SUMMARY');
  lines.push('-'.repeat(80));
  for (const r of all) {
    const rlsFlag = r.kind === 'table' ? (r.rls_enabled ? '[RLS on]' : '[RLS off]') : '';
    const rows = r.rowCount != null ? ` (${r.rowCount} rows)` : '';
    lines.push(`  ${r.kind.padEnd(7)} ${r.name.padEnd(45)} ${rlsFlag}${rows}`);
  }
  lines.push('');

  // Detail per relation
  for (const r of all) {
    lines.push('='.repeat(80));
    lines.push(`${r.kind.toUpperCase()}: ${r.name}`);
    if (r.kind === 'table') {
      lines.push(`  RLS: ${r.rls_enabled ? 'enabled' : 'DISABLED'}`);
      lines.push(`  Row count: ${r.rowCount ?? 'n/a'}`);
    }
    lines.push('-'.repeat(80));

    lines.push('  COLUMNS:');
    for (const c of r.columns) {
      const nullable = c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
      lines.push(`    ${c.column_name.padEnd(35)} ${c.data_type.padEnd(30)} ${nullable}${def}`);
    }

    if (r.pk.length) {
      lines.push('  PRIMARY KEY:');
      lines.push(`    (${r.pk.map((k) => k.column_name).join(', ')})`);
    }

    if (r.fks.length) {
      lines.push('  FOREIGN KEYS:');
      for (const fk of r.fks) {
        lines.push(`    ${fk.column_name} → ${fk.foreign_table}(${fk.foreign_column})  [${fk.constraint_name}]`);
      }
    }

    if (r.indexes.length) {
      lines.push('  INDEXES:');
      for (const idx of r.indexes) {
        lines.push(`    ${idx.indexname}`);
        lines.push(`      ${idx.indexdef}`);
      }
    }

    if (r.policies.length) {
      lines.push('  RLS POLICIES:');
      for (const p of r.policies) {
        lines.push(`    ${p.policyname}  cmd=${p.cmd}`);
        if (p.qual) lines.push(`      USING: ${p.qual}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing DATABASE_URL in .env');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const relations = await listRelations(client, args.table);
    if (relations.length === 0) {
      console.error(`No relations found${args.table ? ` matching "${args.table}"` : ''}`);
      return;
    }

    if (args.tablesOnly) {
      for (const r of relations) console.log(`${r.kind}\t${r.name}\t${r.rls_enabled}`);
      return;
    }

    const audits = [];
    for (const rel of relations) {
      audits.push(await auditRelation(client, rel));
    }

    if (args.json) {
      console.log(JSON.stringify(audits, null, 2));
    } else {
      console.log(renderText(audits));
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('dbAudit: failed:', err.message);
  process.exitCode = 1;
});
