# Regenerates seed-kb.sql from support-knowledge-base.md.
# Run this any time you edit the knowledge base, then paste seed-kb.sql's
# contents into the Cloudflare dashboard's D1 Console (or run it with
# wrangler d1 execute <db-name> --file=seed-kb.sql if you have Wrangler).

$content = Get-Content -Raw -Path (Join-Path $PSScriptRoot "support-knowledge-base.md")
$escaped = $content -replace "'", "''"

$sql = "INSERT INTO kb_content (id, content, updated_at) VALUES (1, '$escaped', datetime('now'))" +
       "`n  ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;"

Set-Content -Path (Join-Path $PSScriptRoot "seed-kb.sql") -Value $sql -NoNewline
Write-Host "Wrote seed-kb.sql. Paste its contents into the D1 Console, or run it with wrangler d1 execute."
