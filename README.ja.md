# dsh-grafana-query

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | 日本語

`dsh-grafana-query` は無料でオープンソースの、**読み取り専用**な DeepSeek Harness 用 Grafana
プラグインです。エージェントが Grafana のデータソースプロキシ経由で PromQL を実行し、
Grafana unified alerting の現在の状態を読み取れるようにします。Grafana 側は一切変更しません。

npm の `dsh-grafana` とは別物です。あちらは dashboard JSON を Grafana へ書き戻す
**書き込み型のダッシュボードエディタ**です。本プラグインはその逆で、読み取り専用の
メトリクスクエリとアラート状態を担当します。ダッシュボードと panel JSON は明確に対象外です。

## Tools

| ツール | 目的 |
| --- | --- |
| `grafana_health` | インスタンスへ接続でき、token が有効かを確認します。 |
| `grafana_list_datasources` | データソースの uid、type、access モードを一覧します。最初に実行してください。 |
| `grafana_query` | データソースプロキシ経由で instant PromQL クエリを実行します。 |
| `grafana_query_range` | step とポイント数の上限を強制したうえで範囲 PromQL クエリを実行します。 |
| `grafana_alert_state` | unified alerting のルールの現在の状態を読み取ります。 |
| `grafana_list_alert_rules` | プロビジョニング済みのアラートルール定義を一覧します。 |

すべてのツールは読み取り専用です。v0.1 は Grafana 上で作成・編集・削除・silence・ack・
一時停止のいずれも行いません。

## Requirements

- 互換性のある `@deepseek-ai/dsh-tools` API を備えた DeepSeek Harness
- Node.js 22.19 以上（22.x 系）または Node.js 24 以上
- **Grafana 9.0 以上** — uid 版のデータソースプロキシ（`/api/datasources/proxy/uid/:uid/*`）
  のみ対応し、非推奨の数値 id パスには対応しません

## Configuration

```sh
export GRAFANA_URL='https://grafana.example.com'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

| 項目 | 環境変数 | 既定値 | 範囲 |
| --- | --- | --- | --- |
| `baseUrl` | `GRAFANA_URL` | 必須 | http(s) URL。認証情報の埋め込み、query、fragment は不可。サブパスは可 |
| `token` | `GRAFANA_TOKEN` | 必須 | 空不可 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN`、`ja` |
| `requestTimeoutMs` | — | `30000` | 1 – 300000 |
| `maxResponseBytes` | — | `5242880` | 1 – 52428800 |
| `maxSeries` | — | `100` | 1 – 1000 |

プラグイン設定は環境変数より優先されます。

## Permissions

Grafana の service account token（推奨）と旧来の API key はどちらも利用できます。
両者とも同じ `Authorization: Bearer` ヘッダーを使います。Grafana Cloud の Access Policy
token（`glc_`）は Cloud のデータエンドポイント用であり、この API では**使えません**。

| ツール | 必要な権限 |
| --- | --- |
| `grafana_health` | なし |
| `grafana_list_datasources` | `datasources:read` |
| `grafana_query`、`grafana_query_range` | `datasources:query`（事前の型チェックには `datasources:read` も必要） |
| `grafana_alert_state` | `alert.rules:read` |
| `grafana_list_alert_rules` | `alert.provisioning:read` |

## Grafana Cloud

`baseUrl` にはスタック自体を指定し、そのスタックで作成した service account token を使います。

```sh
export GRAFANA_URL='https://your-stack.grafana.net'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

ここで `glc_` で始まる Access Policy token は使わないでください。Cloud のスタックには
多数の組み込みデータソースがあるため、`grafana_list_datasources` の `type` と
`name_contains` フィルターで一覧を短く保ってください。

## Install

```sh
bun add dsh-grafana-query
```

パッケージには `cordis.patch.yml` が含まれ、`package.json` の `dsh.bundle.patch` で宣言されます。
これにより DeepSeek Harness のレジストリが既定設定のままプラグインを読み込めます。

## Examples

1. `grafana_list_datasources` に `{"type": "prometheus"}` を渡して uid を取得します。
2. `grafana_query` に `{"datasource_uid": "prom-1", "query": "up"}` を渡して現在値を取得します。
3. `grafana_query_range` に `{"datasource_uid": "prom-1", "query": "rate(node_cpu_seconds_total[5m])", "start": "...", "end": "..."}`
   を渡して推移を取得します。`step` を省略すると、各 series が `max_points` を超えないよう
   プラグインが自動で選びます。
4. `grafana_alert_state` を引数なしで実行し、今何が発報しているかを確認します。

## Internationalization

`locale` に `en`、`zh-TW`、`zh-CN`、`ja` のいずれかを設定すると、モデルが見るツールと
パラメータの説明が切り替わります。ツール名は常に英語のままで、エラーメッセージも常に英語です。

## Security and error behavior

- すべてのツールは読み取り専用です。
- エラーに token、`Authorization` ヘッダー、生のレスポンスボディが含まれることはありません。
- 唯一の例外として、Prometheus が HTTP 400 でクエリを拒否した場合のみ、構造化された
  `error` フィールドを返します。エージェントが PromQL を修正できるようにするためで、
  200 文字が上限、かつ事前に秘匿情報のマスキングを行います。それ以外のステータスコードでは
  常に静的なメッセージを返します。
- レスポンスサイズは `maxResponseBytes`、`maxSeries`、および series ごとのポイント数上限の
  3 段階で制限されます。切り詰めが発生した場合は `meta.truncated` と切り詰め前の合計値に必ず記録されます。

## Development

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## License

MIT
