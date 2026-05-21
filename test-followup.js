// Test follow-up question detection
const studentId = "test-followup-" + Date.now();

async function test(message, expected) {
    const response = await fetch("http://localhost:3000/api/tutor/ask", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Student-Id": studentId
        },
        body: JSON.stringify({ message })
    });
    
    const data = await response.json();
    console.log(`✓ "${message}" → Expected: ${expected}`);
    console.log(`  Response snippet: ${data.response.substring(0, 80)}...\n`);
}

async function runTests() {
    console.log("=== FOLLOW-UP DETECTION TEST ===\n");
    
    // Test 1: Casual greeting
    await test("Hai", "CASUAL");
    
    // Test 2: Academic question - Define transpiration
    await test("Define transpiration", "ACADEMIC");
    
    // Test 3: Follow-up - "Explain more"
    await test("Explain more", "FOLLOW_UP");
    
    // Test 4: Follow-up - "What are the types?"
    await test("What are the types?", "FOLLOW_UP");
    
    // Test 5: New topic - Different subject
    await test("What is Docker?", "NORMAL or ACADEMIC");
}

runTests().catch(console.error);
