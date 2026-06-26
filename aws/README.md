# aws

Stows `~/.aws/config` (the AWS CLI / SSO profile config). Pairs with the
`aws-sso-refresh` pi extension, which authenticates Bedrock using
`AWS_PROFILE=sso-bedrock`.

All profiles share one `[sso-session hfsso]` block, so a single
`aws sso login --profile <any>` authorizes every profile. Profiles:
`sso-bedrock` (Bedrock), `sso-bi` / `sso-bi-developer` / `sso-bi-poweruser`
(main-bi: SCM analytics + datalake S3, `sso-bi` is the default for data work),
and `sso-it` (main-it). See the HelloFresh AGENTS.md "AWS CLI" section for the
S3 access map (the `*-sensitive` SCM bucket is policy-denied to all human SSO
roles).

## Secrets

The real `aws/.aws/config` is **gitignored** because it contains an AWS account
ID and the corporate SSO portal URL, which must not be committed to a public
repo. Only `aws/.aws/config.example` (placeholders) is tracked.

## Restore on a new machine

```sh
cp ~/dotfiles/aws/.aws/config.example ~/dotfiles/aws/.aws/config
# edit aws/.aws/config and fill in your real account_id / sso_start_url
stow --no-folding aws
```

`setup.sh` runs `stow --no-folding aws` automatically, but the symlink only
works once `aws/.aws/config` exists — so create it from the example first.

## Why `--no-folding`

`~/.aws` also holds runtime state (`sso/`, `cli/` cache). `--no-folding`
symlinks only the `config` file so that runtime data stays outside the repo.
