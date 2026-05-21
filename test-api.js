// Test script for /api/answer endpoint
// Usage: node test-api.js

const API_URL = "http://localhost:3000/api/answer";

// Test cases
const testCases = [
    {
        name: "Simple Physics Question",
        question: "What is acceleration? A) Rate of change of velocity B) Rate of change of distance C) Rate of change of time D) None",
        image: null
    },
    {
        name: "Biology Question",
        question: "What is photosynthesis? A) Process of making food in plants B) Process of breathing C) Process of digestion D) None",
        image: null
    },
    {
        name: "Chemistry Question",
        question: "What is the SI unit of pressure? A) Pascal B) Newton C) Joule D) Watt",
        image: null
    }
];

async function testAPI(testCase) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing: ${testCase.name}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Question: ${testCase.question}`);
    console.log(`Image: ${testCase.image || "null"}`);
    console.log(`\nSending request...`);

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                question: testCase.question,
                image: testCase.image
            })
        });

        const data = await response.json();

        if (data.success) {
            console.log(`\n✅ SUCCESS\n`);
            console.log(`Response:\n${data.response}`);
        } else {
            console.log(`\n❌ FAILED`);
            console.log(`Error: ${data.error}`);
        }
    } catch (error) {
        console.log(`\n❌ ERROR`);
        console.log(`Error: ${error.message}`);
    }
}

async function runAllTests() {
    console.log("🚀 Starting API Tests for /api/answer endpoint");
    console.log("Server URL:", API_URL);
    
    for (const testCase of testCases) {
        await testAPI(testCase);
        // Wait 2 seconds between requests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`\n${"=".repeat(60)}`);
    console.log("✅ All tests completed!");
    console.log(`${"=".repeat(60)}\n`);
}

// Run tests
runAllTests();
