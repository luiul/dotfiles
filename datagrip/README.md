# DataGrip

Snapshot of the DataGrip data source config. Same convention as
`claude/settings.json`: not stowed (JetBrains atomic saves would clobber the
symlink), just tracked here and copied into place.

## Where DataGrip 2026 keeps the data sources

There is no `projects/default` anymore (DataGrip 2026.1 deletes it on
startup). The live file is the project-level storage of the `~/projects`
folder, which is the project DataGrip opens:

```
~/projects/.idea/dataSources.xml
```

App-level (shared) storage exists but is empty and its on-disk location is not
stable across versions, so everything lives in that one project file.

## What the config defines

Four data sources: the two pre-existing ones (Snowflake, Databricks query
engine) plus the two global-ops ones added 2026-09-14, both on the bundled
Databricks driver (`driver-ref` = `databricks`) with browser OAuth
(`AuthMech=11`, `Auth_Flow=2`, no stored secrets, no PATs):

| Name | Workspace | Warehouse | Scoped catalog |
| --- | --- | --- | --- |
| `dbx staging (global-ops)` | `hf-community-staging` | `55b1dfeeb6b3f05c` | `global_ops__nonsensitive__dev` |
| `dbx live (global-ops)` | `hf-community-live` | `5ada7a34882f4472` (`global_ops`) | `global_ops__nonsensitive__live` |

First connect opens a browser for SSO. `EnableTokenCache=0` disables the
driver's persistent token cache: with the cache on, driver 2.7.1 fails with
"No token cache passphrase configured" unless a `TokenCachePassPhrase` is set,
and a passphrase does not belong in a git-tracked URL. Cost: each DataGrip
session re-auths once in the browser. The warehouses auto-stop; first connect
after idle takes about a minute while the warehouse starts.

`ConnCatalog` keeps introspection fast (an unscoped Unity Catalog metastore is
slow to enumerate). To browse other catalogs, remove `ConnCatalog` from the
URL in the data source settings, or pick more schemas in the database
explorer's schema selector.

## Access map (verified 2026-09-14, user identity via OAuth U2M)

What each connection can see. Catalogs are Unity Catalog catalogs on the
workspace; schemas inside them still follow UC grants. The explorer only shows
the scoped catalog per connection (see `ConnCatalog` above).

### dbx live (global-ops) — `hf-community-live`

| Catalog | Readable schemas |
| --- | --- |
| `global_ops__nonsensitive__live` | `base_grain`, `business_marts`, `elementary`, `intermediate`, `landing`, `raw`, `standardized` (the production global-ops layers) |
| `global_ops__pii__live` | `landing` |
| `global_ops__pii__dev` | `devpr268_landing`, `devpr277_landing`, `jamiet_landing`, `luisa_landing`, `weningm_landing` |
| `global_ops__sensitive__live` / `__dev` | nothing beyond `information_schema` |
| `landing__nonsensitive__live` | raw Kafka landing: `csku_inventory_forecast`, `culinary_planning_service`, `customer_delivery_planning_service_v2`, `customer_orders_service`, `customer_plans_service`, `distribution_center_registry`, `meal_selection_service`, `menu_planning_service`, `menus_service_kafka`, `product_catalog_service`, `profile_service` |
| `landing__pii__live` | `ingredient_service`, `ingredient_skus_service`, `order_management_service` (PO v2 source), `supplier_service`, `supplier_split_service` |
| `landing__nonsensitive__staging` | `csku_inventory_forecast`, `isa_goat_control_plane` |
| `operations_data_and_decisions__nonsensitive__live` | `highjump`, `procurement`, `quality_app`, `sustainability` |
| `gpso__nonsensitive__live` | `one_product_*` (18 schemas: base_grain, business_mart, customer, ingredient, menu, orders, recipe, …) |
| `consumer_analytics__nonsensitive__live` | `evl_engagement` |
| `growth_analytics__nonsensitive__live` | `communications_reporting`, `conversions_reporting` |
| `people_data_products__nonsensitive__live` | `freshfield` |
| `platform_analytics__nonsensitive__live` | `business_mart`, `dashboard` |
| `product_analytics_scm_tech__nonsensitive__live` | `silver_schema` |
| `global_ai`, `global_ai_staging` | ML/AI product schemas (`clv_for_actives`, `discount_optimizer`, `menu_personalization`, …) |
| `glue` | federated legacy EDW metastore, hundreds of schemas |
| `samples`, `system` | Databricks built-ins (`samples.tpch`, `system.billing`, `system.access`, …) |

### dbx staging (global-ops) — `hf-community-staging`

Verified 2026-09-14 via DataGrip's own introspection cache (the staging CLI
token was expired, so this list comes from the IDE, not the API).

| Catalog | Notes |
| --- | --- |
| `global_ops__nonsensitive__dev` | the main work area: `dbt_test_*` sentinel schemas (bare local dbt runs), one `devpr<N>_*` schema set per deployed PR (e.g. `devpr277_standardized`, `devpr277_base_grain`), personal `<prefix>_*` schemas |
| `global_ops__nonsensitive__staging` | staging deployment target |
| `global_ops__nonsensitive__live` | readable from staging too |
| `global_ops__pii__{dev,staging,live}` | PII landing variants |
| `global_ops__sensitive__{dev,staging,live}` | nothing readable beyond `information_schema` |
| `landing__nonsensitive__{live,staging}`, `landing__pii__live` | raw source catalogs the dbt sources read |
| `operations_data_and_decisions__nonsensitive__{dev,live,staging}` | tribe catalogs |
| shared catalogs | `consumer_analytics__nonsensitive__live`, `gpso__nonsensitive__live`, `growth_analytics__nonsensitive__live`, `people_data_products__nonsensitive__live`, `platform_analytics__nonsensitive__live`, `product_analytics_scm_tech__nonsensitive__live`, `global_ai`, `global_ai_staging` |

## Database explorer dropdown (introspection scope)

The catalog/schema selection shown in each data source's dropdown lives in
`~/projects/.idea/dataSources.local.xml` (per-source `<introspection-scope>`),
also snapshotted in this package. Both dbx sources whitelist every catalog
listed above with all schemas (`@`), excluding `glue` and `hive_metastore`
(huge legacy metastores), `samples` and `system` (built-ins). To change the
selection in the UI: click the schema count next to the data source name in
the database explorer, tick/untick, then refresh this snapshot.

`ConnCatalog` in the URLs only sets the default catalog for new consoles; it
does not limit what the explorer can show (verified: the driver enumerates all
catalogs regardless).

## Restore (fresh machine / after losing the file)

The snapshot is the full merged pair of files (all four sources plus their
introspection scopes). Restore overwrites the live files, so merge by hand if
the live files have newer sources:

```bash
cp ~/dotfiles/datagrip/projects/.idea/dataSources.xml ~/projects/.idea/dataSources.xml
cp ~/dotfiles/datagrip/projects/.idea/dataSources.local.xml ~/projects/.idea/dataSources.local.xml
```

Run while DataGrip is closed, then start it.

## Refresh the snapshot (after adding/editing sources in the UI)

```bash
cp ~/projects/.idea/dataSources.xml ~/dotfiles/datagrip/projects/.idea/dataSources.xml
cp ~/projects/.idea/dataSources.local.xml ~/dotfiles/datagrip/projects/.idea/dataSources.local.xml
```

Passwords and OAuth tokens are never in the XML; DataGrip keeps them in the
macOS keychain.

## Using the connections

- First metadata sync per connection runs when you expand the data source (or
  right-click, Refresh). It walks every whitelisted catalog, so give it a few
  minutes once; afterwards it is incremental.
- Autocomplete reads synced metadata only. If a table or column does not
  complete, expand or refresh its schema once. New objects created after the
  last sync need one more refresh.
- Query console: right-click the data source, New, Query Console (or select it
  and Cmd+Shift+L). The context dropdown at the console top sets the default
  catalog/schema for unqualified names; it starts on the `ConnCatalog` value.
- Run the statement under the cursor (or the selection) with Cmd+Enter.

## Install the app

`cask "datagrip"` is in `brew/Brewfile`. On this machine DataGrip was
installed manually, so `brew install --cask datagrip` will conflict with the
existing `/Applications/DataGrip.app`; only use the Brewfile entry on fresh
setups.
