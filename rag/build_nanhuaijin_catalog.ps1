param(
    [string]$SourceUrl = "https://www.quanxue.cn/ct_nanhuaijin/index.html",
    [string]$OutputDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Strip-Html {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return ""
    }

    $withoutTags = [regex]::Replace($Text, "<[^>]+>", "")
    return ([System.Net.WebUtility]::HtmlDecode($withoutTags)).Trim()
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$headers = @{
    "User-Agent" = "Codex metadata scraper; contact: local user"
}

$html = (Invoke-WebRequest -Uri $SourceUrl -UseBasicParsing -Headers $headers).Content
$sectionPattern = "<div id=['""]index_left['""]>(?<body>.*?)</div>\s*<!--index_left-->"
$sectionMatch = [regex]::Match(
    $html,
    $sectionPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)

if (-not $sectionMatch.Success) {
    throw "Could not find the index_left section in $SourceUrl"
}

$section = $sectionMatch.Groups["body"].Value
$tokenOptions = [System.Text.RegularExpressions.RegexOptions]::Singleline -bor `
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
$tokenPattern = '<caption>(?<caption>.*?)</caption>|<a\s+href=["''](?<href>[^"'']+)["''][^>]*>(?<title>.*?)</a>'
$tokens = [regex]::Matches($section, $tokenPattern, $tokenOptions)

$items = New-Object System.Collections.Generic.List[object]
$category = ""
$baseUri = [System.Uri]$SourceUrl

foreach ($token in $tokens) {
    if ($token.Groups["caption"].Success) {
        $category = Strip-Html $token.Groups["caption"].Value
        continue
    }

    if (-not $token.Groups["href"].Success) {
        continue
    }

    $href = $token.Groups["href"].Value.Trim()
    $title = Strip-Html $token.Groups["title"].Value

    if ([string]::IsNullOrWhiteSpace($href) -or [string]::IsNullOrWhiteSpace($title)) {
        continue
    }

    $absoluteUri = (New-Object System.Uri -ArgumentList $baseUri, $href).AbsoluteUri
    $itemType = if ($href -like "other/*") { "related" } else { "work_or_article" }

    $items.Add([PSCustomObject]@{
        category = $category
        title = $title
        type = $itemType
        relative_url = $href
        url = $absoluteUri
    })
}

$csvPath = Join-Path $OutputDir "nanhuaijin_catalog.csv"
$jsonPath = Join-Path $OutputDir "nanhuaijin_catalog.json"
$mdPath = Join-Path $OutputDir "nanhuaijin_catalog.md"

$items | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$json = [ordered]@{
    source = $SourceUrl
    retrieved_date = (Get-Date -Format "yyyy-MM-dd")
    scope_note = "Metadata only: category, title, type, relative URL, absolute URL. Full text is intentionally excluded."
    item_count = $items.Count
    items = $items
}
$json | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Nan Huaijin catalog")
$lines.Add("")
$lines.Add("- Source: $SourceUrl")
$lines.Add("- Retrieved: $(Get-Date -Format 'yyyy-MM-dd')")
$lines.Add("- Scope: metadata only; full text is intentionally excluded.")
$lines.Add("- Rights note: do not use this index to bulk-copy copyrighted modern works without authorization.")
$lines.Add("")

$seenCategories = New-Object System.Collections.Generic.List[string]
foreach ($item in $items) {
    if (-not $seenCategories.Contains($item.category)) {
        $seenCategories.Add($item.category)
    }
}

foreach ($cat in $seenCategories) {
    $groupItems = @($items | Where-Object { $_.category -eq $cat })
    $lines.Add("## $cat")
    $lines.Add("")
    $lines.Add("| No. | Title | URL |")
    $lines.Add("|---:|---|---|")
    for ($i = 0; $i -lt $groupItems.Count; $i++) {
        $n = $i + 1
        $lines.Add("| $n | $($groupItems[$i].title) | $($groupItems[$i].url) |")
    }
    $lines.Add("")
}

$lines.Add("## Stats")
$lines.Add("")
$lines.Add("- Total items: $($items.Count)")
$lines.Add("- Works/articles: $(($items | Where-Object { $_.type -eq 'work_or_article' }).Count)")
$lines.Add("- Related/memorial items: $(($items | Where-Object { $_.type -eq 'related' }).Count)")

$lines | Set-Content -Path $mdPath -Encoding UTF8

Write-Host "Wrote $($items.Count) items:"
Write-Host " - $mdPath"
Write-Host " - $csvPath"
Write-Host " - $jsonPath"
