// Test keyword overlap detection

function extractKeywords(text) {
    return text
        .toLowerCase()
        .replace(/[?.,!]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 2);
}

function calculateKeywordOverlap(previousText, currentText) {
    const prevKeywords = new Set(extractKeywords(previousText));
    const currKeywords = new Set(extractKeywords(currentText));
    
    console.log("Previous keywords:", Array.from(prevKeywords));
    console.log("Current keywords:", Array.from(currKeywords));
    
    if (prevKeywords.size === 0 || currKeywords.size === 0) return {
        matches: 0,
        currentKeywords: 0,
        overlapPercent: 0,
        isFollowUp: false
    };
    
    let matches = 0;
    for (let keyword of currKeywords) {
        if (prevKeywords.has(keyword)) {
            console.log(`  ✓ Match: "${keyword}"`);
            matches++;
        }
    }
    
    const overlapPercent = (matches / currKeywords.size) * 100;
    
    return {
        matches: matches,
        currentKeywords: currKeywords.size,
        overlapPercent: overlapPercent,
        isFollowUp: overlapPercent >= 40
    };
}

// Test case
const previous = "A child is dragging a 2 kg toy on a horizontal surface. The applied force is 10 N, and the friction force is 4 N. What is the acceleration of the toy?";
const current = "what is acceleration";

console.log("\n=== TEST CASE ===");
console.log("Previous:", previous);
console.log("Current:", current);
console.log("\n=== RESULT ===");
const result = calculateKeywordOverlap(previous, current);
console.log(result);
console.log(`\n${result.isFollowUp ? "✅ FOLLOW_UP" : "❌ NOT FOLLOW_UP"} (${result.matches}/${result.currentKeywords} keywords match = ${result.overlapPercent.toFixed(0)}%)`);
