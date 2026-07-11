param(
    [string]$CatalogCsv = (Join-Path $PSScriptRoot "nanhuaijin_catalog.csv"),
    [string]$OutDir = (Join-Path $PSScriptRoot "nanhuaijin_toc_md"),
    [int]$DelayMs = 300
)

$ErrorActionPreference = "Stop"

function Strip-Html {
    param([string]$Html)
    if ([string]::IsNullOrWhiteSpace($Html)) { return "" }
    $text = [regex]::Replace($Html, "<script\b[^>]*>.*?</script>", "", "Singleline,IgnoreCase")
    $text = [regex]::Replace($text, "<style\b[^>]*>.*?</style>", "", "Singleline,IgnoreCase")
    $text = [regex]::Replace($text, "<[^>]+>", "")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = [regex]::Replace($text, "\s+", " ").Trim()
    return $text
}

function Safe-FileName {
    param([string]$Name)
    $safe = [System.Net.WebUtility]::HtmlDecode($Name)
    $safe = [regex]::Replace($safe, '[\\/:*?"<>|]', '_')
    $safe = [regex]::Replace($safe, "\s+", " ").Trim()
    if ([string]::IsNullOrWhiteSpace($safe)) { return "untitled" }
    return $safe
}

function Get-Title {
    param([string]$Html, [string]$Fallback)
    foreach ($pattern in @(
        "<h1[^>]*>(?<title>.*?)</h1>",
        "<h2[^>]*>(?<title>.*?)</h2>",
        "<h3[^>]*>(?<title>.*?)</h3>",
        "<title[^>]*>(?<title>.*?)</title>"
    )) {
        $m = [regex]::Match($Html, $pattern, "Singleline,IgnoreCase")
        if ($m.Success) {
            $title = Strip-Html $m.Groups["title"].Value
            if (-not [string]::IsNullOrWhiteSpace($title)) { return $title }
        }
    }
    return $Fallback
}

function Get-Page {
    param([string]$Url)
    $headers = @{ "User-Agent" = "Codex TOC metadata crawler; contact: local user" }
    return (Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $headers).Content
}

function Get-ChapterLinks {
    param([string]$Html, [string]$PageUrl)

    $pageUri = [System.Uri]$PageUrl
    $baseDir = $pageUri.AbsoluteUri.Substring(0, $pageUri.AbsoluteUri.LastIndexOf("/") + 1)
    $links = [ordered]@{}
    $pattern = '<a\s+[^>]*href=["''](?<href>[^"'']+)["''][^>]*>(?<text>.*?)</a>'
    $matches = [regex]::Matches($Html, $pattern, "Singleline,IgnoreCase")

    foreach ($m in $matches) {
        $href = $m.Groups["href"].Value.Trim()
        if ($href -match "^(#|javascript:|mailto:)" -or $href -notmatch "\.html?$") { continue }

        $uri = New-Object System.Uri -ArgumentList $pageUri, $href
        if ($uri.Host -ne $pageUri.Host) { continue }
        if ($uri.AbsoluteUri -eq $pageUri.AbsoluteUri) { continue }

        # Keep chapter/article links under the same directory tree only.
        if (-not $uri.AbsoluteUri.StartsWith($baseDir)) { continue }

        $label = Strip-Html $m.Groups["text"].Value
        if ([string]::IsNullOrWhiteSpace($label)) {
            $label = [System.IO.Path]::GetFileNameWithoutExtension($uri.AbsolutePath)
        }
        if (-not $links.Contains($uri.AbsoluteUri)) {
            $links[$uri.AbsoluteUri] = $label
        }
    }
    return $links
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$items = @(Import-Csv $CatalogCsv | Where-Object { $_.type -eq "work_or_article" })
$summary = New-Object System.Collections.Generic.List[object]
$total = $items.Count

for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items[$i]
    $n = $i + 1
    Write-Host "[$n/$total] $($item.title)"

    if ($i -gt 0 -and $DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }

    try {
        $html = Get-Page $item.url
        $pageTitle = Get-Title $html $item.title
        $chapterLinks = Get-ChapterLinks $html $item.url
        $chapterCount = $chapterLinks.Count

        $fileName = ("{0:D3}-{1}.md" -f $n, (Safe-FileName $item.title))
        $filePath = Join-Path $OutDir $fileName

        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add("# $($item.title)")
        $lines.Add("")
        $lines.Add("- Category: $($item.category)")
        $lines.Add("- Source: $($item.url)")
        $lines.Add("- Page title: $pageTitle")
        $lines.Add("- Scope: table of contents and links only; full text intentionally excluded.")
        $lines.Add("- Retrieved: $(Get-Date -Format 'yyyy-MM-dd')")
        $lines.Add("")

        if ($chapterCount -gt 0) {
            $lines.Add("## Chapters")
            $lines.Add("")
            $lines.Add("| No. | Title | URL |")
            $lines.Add("|---:|---|---|")
            $c = 1
            foreach ($url in $chapterLinks.Keys) {
                $lines.Add("| $c | $($chapterLinks[$url]) | $url |")
                $c++
            }
        } else {
            $lines.Add("No chapter links were detected on this page. This may be a single-page article or a page with nonstandard navigation.")
        }

        $lines | Set-Content -Path $filePath -Encoding UTF8

        $summary.Add([PSCustomObject]@{
            order = $n
            category = $item.category
            title = $item.title
            url = $item.url
            chapter_count = $chapterCount
            file = $fileName
            status = "ok"
            error = ""
        })
    } catch {
        $summary.Add([PSCustomObject]@{
            order = $n
            category = $item.category
            title = $item.title
            url = $item.url
            chapter_count = 0
            file = ""
            status = "error"
            error = $_.Exception.Message
        })
    }
}

$summaryCsv = Join-Path $OutDir "_summary.csv"
$summaryJson = Join-Path $OutDir "_summary.json"
$summaryMd = Join-Path $OutDir "_index.md"
$summary | Export-Csv -Path $summaryCsv -NoTypeInformation -Encoding UTF8
$summary | ConvertTo-Json -Depth 4 | Set-Content -Path $summaryJson -Encoding UTF8

$ok = @($summary | Where-Object { $_.status -eq "ok" })
$errors = @($summary | Where-Object { $_.status -ne "ok" })
$md = New-Object System.Collections.Generic.List[string]
$md.Add("# Nan Huaijin TOC metadata crawl")
$md.Add("")
$md.Add("- Retrieved: $(Get-Date -Format 'yyyy-MM-dd')")
$md.Add("- Source catalog: $CatalogCsv")
$md.Add("- Scope: table of contents and links only; full text intentionally excluded.")
$md.Add("- Works/articles requested: $total")
$md.Add("- Successful pages: $($ok.Count)")
$md.Add("- Error pages: $($errors.Count)")
$md.Add("")
$md.Add("| No. | Category | Title | Chapters | File | Source | Status |")
$md.Add("|---:|---|---|---:|---|---|---|")
foreach ($row in $summary) {
    $md.Add("| $($row.order) | $($row.category) | $($row.title) | $($row.chapter_count) | $($row.file) | $($row.url) | $($row.status) |")
}
$md | Set-Content -Path $summaryMd -Encoding UTF8

Write-Host "Done."
Write-Host "Output dir: $OutDir"
Write-Host "Successful pages: $($ok.Count)"
Write-Host "Error pages: $($errors.Count)"
