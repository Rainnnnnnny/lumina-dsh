# Persistent Photoshop COM helper.
# Protocol: one JSON object per line on stdin; one JSON object per line on stdout.
#   {"id":N,"op":"jsx","code":"..."}  -> {"id":N,"ok":true,"result":"..."}
#   {"id":N,"op":"state"}             -> {"id":N,"ok":true,"version":"...","documents":N}
#   {"id":N,"op":"cleanup"}           -> {"id":N,"ok":true}
#   {"id":N,"op":"quit"}              -> {"id":N,"ok":true} then exit
# The helper starts Photoshop hidden and keeps it resident between requests.
$ErrorActionPreference = 'Continue'
try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {}

$OUT = [Console]::Out

function Send-Obj($obj) {
    try {
        $json = $obj | ConvertTo-Json -Compress -Depth 8
        $OUT.WriteLine($json)
        $OUT.Flush()
    } catch {
        try { $OUT.WriteLine('{"ok":false,"error":"serialize failed"}'); $OUT.Flush() } catch {}
    }
}

function Close-AllDocs($ps) {
    try {
        $ps.DoJavaScript("var g=0; while(app.documents.length>0&&g<30){try{app.documents[0].close(SaveOptions.DONOTSAVECHANGES);}catch(e){} g++;} 'ok'") | Out-Null
    } catch {}
}

$ps = $null
try {
    $ps = New-Object -ComObject Photoshop.Application
    try { $ps.Visible = $false } catch {}
    $ready = $false
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $pong = $ps.DoJavaScript("'pong'")
            if ("$pong" -match 'pong') { $ready = $true; break }
        } catch {}
    }
    if (-not $ready) {
        Send-Obj @{ ok = $false; fatal = $true; error = 'photoshop did not become ready' }
        exit 1
    }
    Send-Obj @{ ok = $true; event = 'ready'; version = "$($ps.Version)"; name = "$($ps.Name)" }
} catch {
    Send-Obj @{ ok = $false; fatal = $true; error = $_.Exception.Message }
    exit 1
}

$running = $true
while ($running) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $req = $null
    try { $req = $line | ConvertFrom-Json } catch {
        Send-Obj @{ id = $null; ok = $false; error = 'invalid json' }
        continue
    }

    $id = $null
    try { $id = $req.id } catch {}
    switch ("$($req.op)") {
        'jsx' {
            try {
                $code = [string]$req.code
                if ([string]::IsNullOrWhiteSpace($code)) { throw 'empty jsx code' }
                $result = $ps.DoJavaScript($code)
                Send-Obj @{ id = $id; ok = $true; result = "$result" }
            } catch {
                Send-Obj @{ id = $id; ok = $false; error = $_.Exception.Message }
            }
        }
        'state' {
            try {
                $docs = 0
                try { $docs = [int]$ps.Documents.Count } catch {}
                Send-Obj @{ id = $id; ok = $true; version = "$($ps.Version)"; documents = $docs }
            } catch {
                Send-Obj @{ id = $id; ok = $false; error = $_.Exception.Message }
            }
        }
        'cleanup' {
            Close-AllDocs $ps
            Send-Obj @{ id = $id; ok = $true }
        }
        'quit' {
            Close-AllDocs $ps
            try { $ps.Quit() } catch {}
            Send-Obj @{ id = $id; ok = $true }
            $running = $false
        }
        default {
            Send-Obj @{ id = $id; ok = $false; error = "unknown op: $($req.op)" }
        }
    }
}

# Parent closed stdin: release Photoshop so nothing is left resident.
try { Close-AllDocs $ps } catch {}
try { $ps.Quit() } catch {}
exit 0
