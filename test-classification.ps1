# Test script to verify all 4 classification types
# Usage: .\test-classification.ps1

$tests = @(
    # CASUAL tests
    @{ studentId="casual1"; msg="Hai"; type="casual" },
    @{ studentId="casual2"; msg="Hello, how are you?"; type="casual" },
    
    # ACADEMIC tests
    @{ studentId="academic1"; msg="Define transpiration"; type="academic" },
    @{ studentId="academic2"; msg="What is photosynthesis?"; type="academic" },
    @{ studentId="academic3"; msg="Explain mitosis"; type="academic" },
    
    # FOLLOW-UP tests (need to ask academic first)
    @{ studentId="followup1"; msg="Define transpiration"; type="academic" },
    @{ studentId="followup1"; msg="Explain more"; type="follow-up" },
    @{ studentId="followup2"; msg="What is ecosystem?"; type="academic" },
    @{ studentId="followup2"; msg="What are the types?"; type="follow-up" },
    
    # NORMAL test
    @{ studentId="normal1"; msg="What is Docker?"; type="normal" }
)

Write-Host "🧪 Testing Classification Engine`n" -ForegroundColor Cyan

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
        
        Write-Host "✓ $($test.msg)" -ForegroundColor Green
        Write-Host "  Expected: $($test.type) | Response received" -ForegroundColor Gray
    }
    catch {
        Write-Host "✗ $($test.msg)" -ForegroundColor Red
        Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Gray
    }
    
    Start-Sleep -Milliseconds 200
}

Write-Host "✅ Classification test completed. Check server logs for [CLASSIFICATION] output" -ForegroundColor Yellow
