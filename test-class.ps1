$tests = @(
    @{ studentId="casual1"; msg="Hai"; type="casual" },
    @{ studentId="casual2"; msg="Hello, how are you?"; type="casual" },
    @{ studentId="academic1"; msg="Define transpiration"; type="academic" },
    @{ studentId="academic2"; msg="What is photosynthesis?" ; type="academic" },
    @{ studentId="followup1"; msg="Define transpiration"; type="academic" },
    @{ studentId="followup1"; msg="Explain more"; type="follow-up" },
    @{ studentId="followup2"; msg="What is ecosystem?"; type="academic" },
    @{ studentId="followup2"; msg="What are the types?"; type="follow-up" }
)

Write-Host "Testing Classification Engine" -ForegroundColor Cyan

foreach ($test in $tests) {
    try {
        $body = ConvertTo-Json @{message=$test.msg}
        $headers = @{"X-Student-Id"=$test.studentId}
        
        $response = Invoke-RestMethod -Uri "http://localhost:3000/api/tutor/ask" `
            -Method Post `
            -Body $body `
            -ContentType "application/json" `
            -Headers $headers `
            -ErrorAction Stop
        
        Write-Host "OK - $($test.msg) (expect: $($test.type))" -ForegroundColor Green
    }
    catch {
        Write-Host "ERR - $($test.msg)" -ForegroundColor Red
    }
    
    Start-Sleep -Milliseconds 300
}

Write-Host "Done. Check server logs." -ForegroundColor Yellow
