import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"

export const SCHEMA_PROJECTION_VERSION = 2

const CatalogRowSchema = z.strictObject({
  kind: z.string(),
  identity: z.string(),
  definition: z.string(),
})

const CATALOG_SQL = `
select 'relation' as kind, n.nspname || '.' || c.relname as identity,
  jsonb_build_object(
    'kind', c.relkind, 'persistence', c.relpersistence,
    'replicaIdentity', c.relreplident, 'rowSecurity', c.relrowsecurity,
    'forceRowSecurity', c.relforcerowsecurity, 'partition', c.relispartition,
    'partitionBound', pg_get_expr(c.relpartbound, c.oid, true),
    'options', coalesce((select jsonb_agg(option order by option) from unnest(c.reloptions) option), '[]'::jsonb),
    'ownedByDatabaseOwner', c.relowner = d.datdba
  )::text as definition
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_database d on d.datname = current_database()
where n.nspname = 'public'
union all
select 'column', n.nspname || '.' || c.relname || '.' || a.attname,
  jsonb_build_object(
    'position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod),
    'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
    'default', pg_get_expr(ad.adbin, ad.adrelid, true),
    'collation', case when co.oid is null then null else cn.nspname || '.' || co.collname end
  )::text
from pg_attribute a join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
left join pg_collation co on co.oid = a.attcollation
left join pg_namespace cn on cn.oid = co.collnamespace
where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
union all
select 'constraint', n.nspname || '.' || c.relname || '.' || con.conname,
  jsonb_build_object(
    'type', con.contype, 'deferrable', con.condeferrable, 'deferred', con.condeferred,
    'validated', con.convalidated, 'definition', pg_get_constraintdef(con.oid, true)
  )::text
from pg_constraint con join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
select 'index', n.nspname || '.' || c.relname || '.' || i.relname,
  jsonb_build_object(
    'unique', x.indisunique, 'primary', x.indisprimary, 'exclusion', x.indisexclusion,
    'valid', x.indisvalid, 'ready', x.indisready, 'method', am.amname,
    'definition', pg_get_indexdef(i.oid), 'predicate', pg_get_expr(x.indpred, x.indrelid, true),
    'options', coalesce((select jsonb_agg(option order by option) from unnest(i.reloptions) option), '[]'::jsonb)
  )::text
from pg_index x join pg_class c on c.oid = x.indrelid
join pg_namespace n on n.oid = c.relnamespace join pg_class i on i.oid = x.indexrelid
join pg_am am on am.oid = i.relam where n.nspname = 'public'
union all
select 'rule', n.nspname || '.' || c.relname || '.' || r.rulename,
  jsonb_build_object('event', r.ev_type, 'enabled', r.ev_enabled, 'definition', pg_get_ruledef(r.oid, true))::text
from pg_rewrite r join pg_class c on c.oid = r.ev_class
join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
  jsonb_build_object(
    'enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid, true),
    'function', pn.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  )::text
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where n.nspname = 'public' and not t.tgisinternal
union all
select 'routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
  jsonb_build_object(
    'kind', p.prokind, 'returns', pg_get_function_result(p.oid), 'volatile', p.provolatile,
    'parallel', p.proparallel, 'securityDefiner', p.prosecdef,
    'config', coalesce((select jsonb_agg(setting order by setting) from unnest(p.proconfig) setting), '[]'::jsonb),
    'definition', pg_get_functiondef(p.oid), 'ownedByDatabaseOwner', p.proowner = d.datdba
  )::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
join pg_database d on d.datname = current_database() where n.nspname = 'public'
union all
select 'type', n.nspname || '.' || t.typname,
  jsonb_build_object(
    'kind', t.typtype, 'category', t.typcategory, 'preferred', t.typispreferred,
    'notNull', t.typnotnull, 'byValue', t.typbyval, 'length', t.typlen,
    'delimiter', t.typdelim, 'alignment', t.typalign, 'storage', t.typstorage,
    'relation', case when c.oid is null then null else rn.nspname || '.' || c.relname end,
    'relationKind', c.relkind,
    'element', case when et.oid is null then null else en.nspname || '.' || et.typname end,
    'base', case when bt.oid is null then null else bn.nspname || '.' || bt.typname end,
    'typeModifier', t.typtypmod, 'dimensions', t.typndims, 'default', t.typdefault,
    'collation', case when co.oid is null then null else cn.nspname || '.' || co.collname end,
    'enumLabels', coalesce((select jsonb_agg(e.enumlabel order by e.enumsortorder)
      from pg_enum e where e.enumtypid = t.oid), '[]'::jsonb),
    'domainConstraints', coalesce((select jsonb_agg(pg_get_constraintdef(con.oid, true)
      order by con.conname) from pg_constraint con where con.contypid = t.oid), '[]'::jsonb),
    'ownedByDatabaseOwner', t.typowner = d.datdba
  )::text
from pg_type t join pg_namespace n on n.oid = t.typnamespace
join pg_database d on d.datname = current_database()
left join pg_class c on c.oid = t.typrelid left join pg_namespace rn on rn.oid = c.relnamespace
left join pg_type et on et.oid = t.typelem left join pg_namespace en on en.oid = et.typnamespace
left join pg_type bt on bt.oid = t.typbasetype left join pg_namespace bn on bn.oid = bt.typnamespace
left join pg_collation co on co.oid = t.typcollation left join pg_namespace cn on cn.oid = co.collnamespace
where n.nspname = 'public'
union all
select 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
  jsonb_build_object(
    'permissive', p.polpermissive, 'command', p.polcmd,
    'using', pg_get_expr(p.polqual, p.polrelid, true),
    'check', pg_get_expr(p.polwithcheck, p.polrelid, true)
  )::text
from pg_policy p join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
select 'sequence', n.nspname || '.' || c.relname,
  jsonb_build_object(
    'type', format_type(s.seqtypid, null), 'start', s.seqstart, 'increment', s.seqincrement,
    'maximum', s.seqmax, 'minimum', s.seqmin, 'cache', s.seqcache, 'cycle', s.seqcycle
  )::text
from pg_sequence s join pg_class c on c.oid = s.seqrelid
join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
select 'operator', n.nspname || '.' || o.oprname || '(' ||
  format_type(o.oprleft, null) || ',' || format_type(o.oprright, null) || ')',
  jsonb_build_object('kind', o.oprkind, 'canMerge', o.oprcanmerge, 'canHash', o.oprcanhash)::text
from pg_operator o join pg_namespace n on n.oid = o.oprnamespace where n.nspname = 'public'
union all
select 'collation', n.nspname || '.' || c.collname,
  jsonb_build_object('provider', c.collprovider, 'deterministic', c.collisdeterministic,
    'locale', c.colllocale, 'icuRules', c.collicurules)::text
from pg_collation c join pg_namespace n on n.oid = c.collnamespace where n.nspname = 'public'
union all
select 'conversion', n.nspname || '.' || c.conname,
  jsonb_build_object('source', pg_encoding_to_char(c.conforencoding),
    'target', pg_encoding_to_char(c.contoencoding), 'default', c.condefault)::text
from pg_conversion c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
union all
select 'operatorClass', n.nspname || '.' || o.opcname,
  jsonb_build_object('method', am.amname, 'default', o.opcdefault,
    'inputType', format_type(o.opcintype, null))::text
from pg_opclass o join pg_namespace n on n.oid = o.opcnamespace
join pg_am am on am.oid = o.opcmethod where n.nspname = 'public'
union all
select 'operatorFamily', n.nspname || '.' || o.opfname,
  jsonb_build_object('method', am.amname)::text
from pg_opfamily o join pg_namespace n on n.oid = o.opfnamespace
join pg_am am on am.oid = o.opfmethod where n.nspname = 'public'
union all
select 'extendedStatistics', n.nspname || '.' || s.stxname,
  jsonb_build_object('kinds', s.stxkind::text, 'definition', pg_get_statisticsobjdef(s.oid))::text
from pg_statistic_ext s join pg_namespace n on n.oid = s.stxnamespace where n.nspname = 'public'
union all
select 'cast', format_type(c.castsource, null) || '->' || format_type(c.casttarget, null),
  jsonb_build_object('context', c.castcontext, 'method', c.castmethod,
    'function', case when p.oid is null then null else pn.nspname || '.' || p.proname ||
      '(' || pg_get_function_identity_arguments(p.oid) || ')' end)::text
from pg_cast c join pg_type source on source.oid = c.castsource
join pg_namespace sn on sn.oid = source.typnamespace
join pg_type target on target.oid = c.casttarget
join pg_namespace tn on tn.oid = target.typnamespace
left join pg_proc p on p.oid = c.castfunc left join pg_namespace pn on pn.oid = p.pronamespace
where sn.nspname = 'public' or tn.nspname = 'public'
union all
select 'transform', n.nspname || '.' || t.typname || ':' || l.lanname,
  jsonb_build_object('fromSql', fp.proname, 'toSql', tp.proname)::text
from pg_transform x join pg_type t on t.oid = x.trftype
join pg_namespace n on n.oid = t.typnamespace join pg_language l on l.oid = x.trflang
left join pg_proc fp on fp.oid = x.trffromsql left join pg_proc tp on tp.oid = x.trftosql
where n.nspname = 'public'
union all
select 'textSearchConfiguration', n.nspname || '.' || c.cfgname,
  jsonb_build_object('parser', pn.nspname || '.' || p.prsname)::text
from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace
join pg_ts_parser p on p.oid = c.cfgparser join pg_namespace pn on pn.oid = p.prsnamespace
where n.nspname = 'public'
union all
select 'textSearchDictionary', n.nspname || '.' || d.dictname,
  jsonb_build_object('template', tn.nspname || '.' || t.tmplname, 'options', d.dictinitoption)::text
from pg_ts_dict d join pg_namespace n on n.oid = d.dictnamespace
join pg_ts_template t on t.oid = d.dicttemplate join pg_namespace tn on tn.oid = t.tmplnamespace
where n.nspname = 'public'
union all
select 'textSearchParser', n.nspname || '.' || p.prsname, '{}'::jsonb::text
from pg_ts_parser p join pg_namespace n on n.oid = p.prsnamespace where n.nspname = 'public'
union all
select 'textSearchTemplate', n.nspname || '.' || t.tmplname, '{}'::jsonb::text
from pg_ts_template t join pg_namespace n on n.oid = t.tmplnamespace where n.nspname = 'public'
union all
select 'securityLabel', identity.name || ':' || s.provider,
  jsonb_build_object('label', s.label)::text
from pg_seclabel s join lateral (
  select n.nspname || '.' || c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where s.classoid = 'pg_class'::regclass and c.oid = s.objoid and n.nspname = 'public'
  union all
  select n.nspname || '.' || p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where s.classoid = 'pg_proc'::regclass and p.oid = s.objoid and n.nspname = 'public'
  union all
  select n.nspname || '.' || t.typname from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where s.classoid = 'pg_type'::regclass and t.oid = s.objoid and n.nspname = 'public'
) identity on true
union all
select 'extension', e.extname, (
  jsonb_build_object(
    'version', e.extversion, 'schema', n.nspname, 'relocatable', e.extrelocatable
  ) || case when e.extname = 'plpgsql' then '{}'::jsonb else
    jsonb_build_object('ownedByDatabaseOwner', e.extowner = d.datdba) end
  )::text as definition
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
join pg_database d on d.datname = current_database()
`

export async function schemaFingerprint(sql: TransactionSql): Promise<string> {
  await sql`set local search_path = pg_catalog, public`
  const rows = await sql.unsafe(CATALOG_SQL)
  const canonical = rows
    .map((row) => CatalogRowSchema.parse(row))
    .map(({ kind, identity, definition }) => `${kind}\0${identity}\0${definition}\n`)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .join("")
  return createHash("sha256")
    .update(`afw-schema-projection-v${SCHEMA_PROJECTION_VERSION}\n`)
    .update(canonical)
    .digest("hex")
}
