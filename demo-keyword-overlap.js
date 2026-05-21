// Demo: Keyword Overlap for Follow-up Detection
// Examples from Step B requirements

// Function to extract keywords (same as in server.js)
function extractKeywords(text) {
    const stopWords = new Set([
        "what", "is", "are", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "as", "be", "been", "have", "has", "do", "does", "did",
        "can", "could", "should", "would", "will", "this", "that", "these", "those", "i", "you",
        "he", "she", "it", "we", "they", "explain", "define", "give", "tell", "describe"
    ]);
    
    return text
        .toLowerCase()
        .replace(/[?.,!]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word));
}

function calculateKeywordOverlap(previousText, currentText) {
    const prevKeywords = new Set(extractKeywords(previousText));
    const currKeywords = new Set(extractKeywords(currentText));
    
    if (prevKeywords.size === 0 || currKeywords.size === 0) return 0;
    
    let matches = 0;
    for (let keyword of currKeywords) {
        if (prevKeywords.has(keyword)) matches++;
    }
    
    const overlapPercent = (matches / currKeywords.size) * 100;
    
    return {
        matches: matches,
        currentKeywords: currKeywords.size,
        prevKeywords: Array.from(prevKeywords),
        currKeywords: Array.from(currKeywords),
        overlapPercent: overlapPercent,
        isFollowUp: overlapPercent >= 40
    };
}

// Test cases from Step B
const tests = [
    {
        name: "NO keyword match → New Topic",
        previous: "Pyramid of biomass",
        current: "What is pond ecosystem",
        expectedFollowUp: false
    },
    {
        name: "HIGH keyword match → Follow-up",
        previous: "What is pond ecosystem",
        current: "Explain its components",
        expectedFollowUp: true
    },
    {
        name: "Partial keyword match → Follow-up",
        previous: "Define transpiration",
        current: "Explain more about transpiration",
        expectedFollowUp: true
    },
    {
        name: "Different topic → New Topic",
        previous: "What is photosynthesis",
        current: "What is respiration",
        expectedFollowUp: false
    }
];

console.log("🧪 KEYWORD OVERLAP TESTING\n");
console.log("Threshold: 40% overlap = FOLLOW_UP\n");

tests.forEach((test, i) => {
    const result = calculateKeywordOverlap(test.previous, test.current);
    const status = result.isFollowUp === test.expectedFollowUp ? "✅" : "❌";
    
    console.log(`${status} Test ${i+1}: ${test.name}`);
    console.log(`   Previous: "${test.previous}"`);
    console.log(`   Current:  "${test.current}"`);
    console.log(`   Keywords matched: ${result.matches}/${result.currentKeywords} (${result.overlapPercent.toFixed(0)}%)`);
    console.log(`   Classification: ${result.isFollowUp ? "FOLLOW_UP" : "NEW TOPIC"}`);
    console.log();
});
