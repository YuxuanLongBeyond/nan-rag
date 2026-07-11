param(
    [Parameter(Mandatory = $true)]
    [string]$StartUrl,

    [string]$Title = "",

    [string]$OutDir = (Join-Path $PSScriptRoot "public_domain_md"),

    [switch]$ConfirmPublicDomain,

    [int]$DelayMs = 800,

    [int]$MaxPages = 0
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmPublicDomain) {
    throw "This crawler is only for public-domain, openly licensed, or explicitly authorized content. Re-run with -ConfirmPublicDomain after verifying rights and the site's terms."
}

function Get-SafeFileName {
    param([string]$Name)
    $safe = [System.Net.WebUtility]::HtmlDecode($Name)
    $safe = [regex]::Replace($safe, "[\\/:*?""<>|]", "_")
    $safe = [regex]::Replace($safe, "\s+", " ").Trim()
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return "untitled"
    }
    return $safe
}

function Get-Page {
    param([string]$Url)
    $headers = @{
        "User-Agent" = "Codex public-domain markdown crawler; contact: local user"
    }
    return (Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $headers).Content
}

function Strip-Html {
    param([string]$Html)
    if ([string]::IsNullOrWhiteSpace($Html)) {
        return ""
    }
    $text = [regex]::Replace($Html, "<script\b[^>]*>.*?</script>", "", "Singleline,IgnoreCase")
    $text = [regex]::Replace($text, "<style\b[^>]*>.*?</style>", "", "Singleline,IgnoreCase")
    $text = [regex]::Replace($text, "<!--.*?-->", "", "Singleline")
    $text = [regex]::Replace($text, "<br\s*/?>", "`n", "IgnoreCase")
    $text = [regex]::Replace($text, "</(p|div|li|tr|h1|h2|h3|h4)>", "`n`n", "IgnoreCase")
    $text = [regex]::Replace($text, "<[^>]+>", "")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace "`r", "`n"
    $text = [regex]::Replace($text, "[ `t]+", " ")
    $text = [regex]::Replace($text, "\n{3,}", "`n`n")
    return $text.Trim()
}

function Get-HtmlTitle {
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
            if (-not [string]::IsNullOrWhiteSpace($title)) {
                return $title
            }
        }
    }
    return $Fallback
}

function Get-BodyHtml {
    param([string]$Html)
    $body = [regex]::Match($Html, "<body[^>]*>(?<body>.*?)</body>", "Singleline,IgnoreCase")
    if ($body.Success) {
        return $body.Groups["body"].Value
    }
    return $Html
}

function Get-ChapterLinks {
    param([string]$Html, [System.Uri]$IndexUri)

    $baseDir = $IndexUri.AbsoluteUri.Substring(0, $IndexUri.AbsoluteUri.LastIndexOf("/") + 1)
    $links = [ordered]@{}
    $pattern = '<a\s+[^>]*href=["''](?<href>[^"'']+)["''][^>]*>(?<text>.*?)</a>'
    $matches = [regex]::Matches($Html, $pattern, "Singleline,IgnoreCase")

    foreach ($m in $matches) {
        $href = $m.Groups["href"].Value.Trim()
        if ($href -match "^(#|javascript:|mailto:)" -or $href -notmatch "\.html?$") {
            continue
        }

        $uri = New-Object System.Uri -ArgumentList $IndexUri, $href
        if ($uri.Host -ne $IndexUri.Host) {
            continue
        }
        if (-not $uri.AbsoluteUri.StartsWith($baseDir)) {
            continue
        }
        if ($uri.AbsoluteUri -eq $IndexUri.AbsoluteUri) {
            continue
        }

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

$indexUri = [System.Uri]$StartUrl
$indexHtml = Get-Page $StartUrl
$bookTitle = if ([string]::IsNullOrWhiteSpace($Title)) {
    Get-HtmlTitle $indexHtml ([System.IO.Path]::GetFileNameWithoutExtension($indexUri.AbsolutePath))
} else {
    $Title
}

$bookOutDir = Join-Path $OutDir (Get-SafeFileName $bookTitle)
New-Item -ItemType Directory -Force -Path $bookOutDir | Out-Null

$chapterLinks = Get-ChapterLinks $indexHtml $indexUri
if ($chapterLinks.Count -eq 0) {
    $chapterLinks[$indexUri.AbsoluteUri] = $bookTitle
}

$chapters = @()
foreach ($key in $chapterLinks.Keys) {
    $chapters += [PSCustomObject]@{
        url = $key
        label = $chapterLinks[$key]
    }
}

if ($MaxPages -gt 0) {
    $chapters = @($chapters | Select-Object -First $MaxPages)
}

$manifest = New-Object System.Collections.Generic.List[object]
$combined = New-Object System.Collections.Generic.List[string]
$combined.Add("# $bookTitle")
$combined.Add("")
$combined.Add("- Source index: $StartUrl")
$combined.Add("- Retrieved: $(Get-Date -Format 'yyyy-MM-dd')")
$combined.Add("- Rights guard: user confirmed public-domain/open-license/authorized use with -ConfirmPublicDomain.")
$combined.Add("")

for ($i = 0; $i -lt $chapters.Count; $i++) {
    $chapter = $chapters[$i]
    $number = "{0:D3}" -f ($i + 1)
    Write-Host "Fetching $number / $($chapters.Count): $($chapter.url)"

    if ($i -gt 0 -and $DelayMs -gt 0) {
        Start-Sleep -Milliseconds $DelayMs
    }

    $chapterHtml = Get-Page $chapter.url
    $chapterTitle = Get-HtmlTitle $chapterHtml $chapter.label
    $body = Get-BodyHtml $chapterHtml
    $text = Strip-Html $body

    $fileName = "$number-$((Get-SafeFileName $chapterTitle)).md"
    $path = Join-Path $bookOutDir $fileName

    $doc = @(
        "---",
        "source: $($chapter.url)",
        "retrieved: $(Get-Date -Format 'yyyy-MM-dd')",
        "rights: public-domain-or-authorized-confirmed-by-user",
        "---",
        "",
        "# $chapterTitle",
        "",
        $text,
        ""
    )
    $doc | Set-Content -Path $path -Encoding UTF8

    $combined.Add("## $chapterTitle")
    $combined.Add("")
    $combined.Add("Source: $($chapter.url)")
    $combined.Add("")
    $combined.Add($text)
    $combined.Add("")

    $manifest.Add([PSCustomObject]@{
        order = $i + 1
        title = $chapterTitle
        url = $chapter.url
        file = $fileName
    })
}

$combinedPath = Join-Path $bookOutDir "_combined.md"
$manifestPath = Join-Path $bookOutDir "_manifest.csv"
$combined | Set-Content -Path $combinedPath -Encoding UTF8
$manifest | Export-Csv -Path $manifestPath -NoTypeInformation -Encoding UTF8

Write-Host "Done:"
Write-Host " - $bookOutDir"
Write-Host " - $combinedPath"
Write-Host " - $manifestPath"
