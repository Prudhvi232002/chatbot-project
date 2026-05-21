import OpenAI from "openai";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import db, { getSession as dbGetSession, upsertSession as dbUpsertSession, addMessage as dbAddMessage, getHistory as dbGetHistory, clearSession as dbClearSession, saveQuestionKeywords, getPreviousQuestionsWithKeywords, compareKeywordOverlapDB, displayDatabaseContents, updateBaseQuestionId, getBaseQuestion, deleteLastQuestion } from "./db.js";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { createCanvas, loadImage } from "canvas";

// ========================================
// API REQUEST LOGGING SYSTEM
// ========================================
const apiLogs = [];
const MAX_LOGS = 100; // Keep last 100 requests

function logAPIRequest(endpoint, request, response, duration) {
    const logEntry = {
        id: apiLogs.length + 1,
        timestamp: new Date().toISOString(),
        endpoint,
        request: {
            question: request.question,
            hasImage: !!request.image
        },
        response: {
            success: response.success,
            responsePreview: response.response ? response.response.substring(0, 200) + '...' : null,
            fullResponse: response.response,
            error: response.error
        },
        duration: `${duration}ms`
    };
    
    apiLogs.unshift(logEntry); // Add to beginning
    if (apiLogs.length > MAX_LOGS) {
        apiLogs.pop(); // Remove oldest
    }
    
    console.log(`[API LOG] ${endpoint} - ${duration}ms - ${response.success ? '✅' : '❌'}`);
}

function clearAPILogs() {
    apiLogs.length = 0;
}

// ========================================
// MESSAGE CLASSIFICATION ENGINE
// Types: CASUAL, ACADEMIC, FOLLOW_UP, NORMAL
// ========================================

// ========================================
// QUESTION TYPE DETECTION
// ========================================

// Detect if question is asking for a concept/definition
function isConceptQuestion(text) {
    if (!text || typeof text !== 'string') {
        return false;
    }
    
    const conceptPatterns = [
        /what is/i,
        /what are/i,
        /define/i,
        /definition of/i,
        /explain/i,
        /describe/i,
        /how does.*work/i,
        /tell me about/i,
        /meaning of/i
    ];
    
    return conceptPatterns.some(pattern => pattern.test(text));
}

// Detect if user proposed an answer (like "I think it's B" or "Is it option A?")
function detectAnswerVerification(text) {
    // Detects questions like: "Is C) Mitochondria correct?", "Is this the right answer?", "option a is correct", etc.
    const verificationPatterns = [
        /is.*correct/i,
        /is.*right/i,
        /is.*wrong/i,
        /did.*get.*right/i,
        /am.*right/i,
        /is.*my.*answer/i,
        /is.*option.*[a-d]/i,
        /is.*[a-d]\).*correct/i,
        /is.*[a-d]\).*right/i,
        /[a-d]\).*correct/i,
        /[a-d]\).*right/i,
        /answer.*correct/i,
        /answer.*right/i,
        // ⭐ NEW: Catch "option a/b/c/d" patterns (e.g., "option a is correct", "option b correct", etc.)
        /option\s*[a-d].*correct/i,
        /option\s*[a-d].*right/i,
        /option\s*[a-d].*wrong/i,
        // ⭐ Also catch bare option letters with correct/right/wrong
        /^[a-d]\s+(?:is\s+)?(?:correct|right|wrong)/i
    ];
    
    return verificationPatterns.some(pattern => pattern.test(text.toLowerCase()));
}

function detectAnswerProposal(text) {
    if (!text || typeof text !== 'string') {
        return { hasProposal: false, proposedAnswer: null };
    }
    
    const answerPatterns = [
        /i think.*\b[a-d]\b/i,
        /i believe.*\b[a-d]\b/i,
        /it is.*\b[a-d]\b/i,
        /it's.*\b[a-d]\b/i,
        /answer is.*\b[a-d]\b/i,
        /option.*\b[a-d]\b/i,
        /is it.*\b[a-d]\b/i,
        /\b[a-d]\b.*right/i,
        /\b[a-d]\b.*correct/i,
        /my answer.*\b[a-d]\b/i,
        // ⭐ IMPLICIT PROPOSALS: "what is [noun]", "tell me about [noun]", "explain [noun]"
        // These are implicit answer proposals when asking about a specific option
        /^(what|tell|explain|describe|how).{0,30}(thermometer|barometer|ammeter|voltmeter|coulomb|newton|joule|pascal|watt|hertz|kelvin|mitochondria|chloroplast|ribosome|nucleus|cell|enzyme|protein|dna|rna|photosynthesis|respiration)/i
    ];
    
    const hasProposal = answerPatterns.some(pattern => pattern.test(text));
    
    if (hasProposal) {
        // Extract the proposed option or noun
        const match = text.match(/\b([a-d])\b/i);
        return {
            hasProposal: true,
            proposedAnswer: (match && match[1]) ? match[1].toUpperCase() : null
        };
    }
    
    return { hasProposal: false, proposedAnswer: null };
}

// Detect if user is requesting confirmation
function detectConfirmationRequest(text) {
    if (!text || typeof text !== 'string') {
        return false;
    }
    
    const confirmationPatterns = [
        /is this correct/i,
        /am i right/i,
        /is it right/i,
        /is that correct/i,
        /correct\?/i,
        /right\?/i,
        /check my answer/i,
        /verify/i,
        /confirm/i
    ];
    
    return confirmationPatterns.some(pattern => pattern.test(text));
}

// ⭐ NEW: Extract answer option words from MCQ question
function extractAnswerOptionsFromQuestion(question) {
    // List of common answer option words in NEET questions
    const answerOptionWords = [
        'thermometer', 'barometer', 'ammeter', 'voltmeter', 'galvanometer',
        'coulomb', 'newton', 'joule', 'pascal', 'watt', 'hertz', 'kelvin', 'ampere', 'ohm',
        'mitochondria', 'chloroplast', 'ribosome', 'nucleus', 'cell', 'enzyme', 'protein',
        'dna', 'rna', 'photosynthesis', 'respiration', 'atp', 'nadh',
        'glucose', 'fructose', 'sucrose', 'lactose',
        'oxygen', 'nitrogen', 'carbon', 'hydrogen', 'oxygen', 'helium',
        'iron', 'copper', 'zinc', 'silver', 'gold', 'aluminum'
    ];
    
    const foundWords = [];
    const questionLower = question.toLowerCase();
    
    for (const word of answerOptionWords) {
        if (questionLower.includes(word)) {
            foundWords.push(word);
        }
    }
    
    return foundWords;
}

// ⭐ NEW: Get related keywords to mask based on answer option
function getRelatedKeywordsToMask(answerWord) {
    const relatedKeywords = {
        'thermometer': ['temperature', 'thermal', 'expansion', 'mercury', 'celsius', 'fahrenheit', 'heat measurement'],
        'barometer': ['pressure', 'atmospheric', 'altitude', 'weather prediction', 'pascals', 'mercury column'],
        'ammeter': ['current', 'ampere', 'amps', 'electrical flow', 'series connection'],
        'voltmeter': ['voltage', 'volt', 'potential difference', 'parallel connection'],
        'coulomb': ['charge', 'electrical charge', 'unit of charge'],
        'newton': ['force', 'weight', 'unit of force'],
        'joule': ['energy', 'work', 'unit of energy'],
        'pascal': ['pressure', 'unit of pressure'],
        'watt': ['power', 'unit of power'],
        'hertz': ['frequency', 'unit of frequency'],
        'kelvin': ['absolute temperature', 'unit of temperature'],
        'ampere': ['current', 'electrical current', 'unit of current']
    };
    
    return relatedKeywords[answerWord.toLowerCase()] || [];
}

// ⭐ ENHANCED: Mask answer words AND related keywords in AI response
function maskAnswerWordsInResponse(response, answerWords) {
    let maskedResponse = response;
    
    // Replace each answer word with a masked version
    for (const word of answerWords) {
        const mask = `[Answer option]`;
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        maskedResponse = maskedResponse.replace(regex, mask);
        
        // Also mask related keywords
        const relatedKeywords = getRelatedKeywordsToMask(word);
        for (const relatedWord of relatedKeywords) {
            const relatedRegex = new RegExp(`\\b${relatedWord}\\b`, 'gi');
            maskedResponse = maskedResponse.replace(relatedRegex, '[measurement aspect]');
        }
    }
    
    return maskedResponse;
}

// ⭐ LEVENSHTEIN DISTANCE - Measure how different two words are
function levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const d = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) d[0][i] = i;
    for (let j = 0; j <= len2; j++) d[j][0] = j;
    
    for (let j = 1; j <= len2; j++) {
        for (let i = 1; i <= len1; i++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            d[j][i] = Math.min(
                d[j][i - 1] + 1,      // Deletion
                d[j - 1][i] + 1,      // Insertion
                d[j - 1][i - 1] + cost // Substitution
            );
        }
    }
    return d[len2][len1];
}

// ⭐ FUZZY MATCH - Find similar words and correct them
function fuzzyCorrectWord(word, commonWords) {
    if (word.length < 3) return word; // Skip short words
    
    let bestMatch = word;
    let bestDistance = 999;
    
    for (const correctWord of commonWords) {
        const distance = levenshteinDistance(word.toLowerCase(), correctWord.toLowerCase());
        // Allow corrections if distance is small relative to word length
        if (distance < bestDistance && distance <= Math.ceil(correctWord.length * 0.4)) {
            bestDistance = distance;
            bestMatch = correctWord;
        }
    }
    
    return bestMatch;
}

// AUTO-CORRECT function - Fix typos like ChatGPT
function autoCorrectText(text) {
    if (!text) return text;
    
    let corrected = text.toLowerCase();
    
    // Common typo corrections for NEET questions
    const typoMap = {
        // Common word typos
        'whasts': 'what',
        'whats': 'what',
        'whast': 'what',
        'hwat': 'what',
        'hwo': 'how',
        'wichh': 'which',
        'wich': 'which',
        'wihch': 'which',
        'oragnelle': 'organelle',
        'organele': 'organelle',
        'powerhos': 'powerhouse',
        'powerhous': 'powerhouse',
        'powe': 'power',
        'hte': 'the',
        'teh': 'the',
        'rhe': 'the',
        'fo': 'for',
        'od': 'of',
        'fro': 'for',
        'wrod': 'word',
        'wroods': 'words',
        'si': 'is',
        'si': 'is',
        'ar': 'are',
        'aer': 'are',
        'knwon': 'known',
        'nwon': 'known',
        'nucleusis': 'nucleus is',
        
        // Truncated words
        'ell': 'cell',
        
        // ⭐ MITOCHONDRIA - ALL VARIATIONS
        'mitochondri': 'mitochondria',
        'mithochondri': 'mitochondria',
        'mithochondria': 'mitochondria',
        'mitocondria': 'mitochondria',
        'mitochondira': 'mitochondria',
        'mitochondroia': 'mitochondria',
        'mitochondriaoa': 'mitochondria',
        'ithhondiroa': 'mitochondria',  // ← User's typo
        'mithhondiroa': 'mitochondria',  // ← User's typo
        'mithochondiroa': 'mitochondria',  // ← User's typo
        'mitochondroa': 'mitochondria',
        'mitochondraia': 'mitochondria',
        'mithocondria': 'mitochondria',
        'methochondria': 'mitochondria',
        'mathochondria': 'mitochondria',
        'mithocondria': 'mitochondria',
        'mithocondria': 'mitochondria',
        'mitochondare': 'mitochondria',
        'mitochondrai': 'mitochondria',
        'mithochondraia': 'mitochondria',
        'micochondria': 'mitochondria',
        'mithcodria': 'mitochondria',
        'mithondria': 'mitochondria',
        
        'chloroplas': 'chloroplast',
        'chloroplst': 'chloroplast',
        'ribosom': 'ribosome',
        'ribsom': 'ribosome',
        'nuclus': 'nucleus',
        'nucleous': 'nucleus',
        'nuclesu': 'nucleus',
        'photosynthesi': 'photosynthesis',
        'photosynthesis': 'photosynthesis',
        'respiratio': 'respiration',
        'respiration': 'respiration',
        'genom': 'genome',
        'protei': 'protein',
        'protien': 'protein',
        'enzym': 'enzyme',
        'chromosom': 'chromosome',
        'chromsome': 'chromosome',
        'golgi': 'golgi',
        
        // Common NEET exam typos
        'organisme': 'organism',
        'chrosome': 'chromosome',
        'dna': 'dna',
        'rna': 'rna',
        'atp': 'atp',
        'gtp': 'gtp',
        'nad': 'nad',
        'nad+': 'nad+',
        'nadh': 'nadh',
        'nadph': 'nadph',
        'fadh': 'fadh',
        'fadh2': 'fadh2',
        'glucos': 'glucose',
        'glucose': 'glucose',
        'oxydation': 'oxidation',
        'reductio': 'reduction',
        'lysosom': 'lysosome',
        'lyssom': 'lysosome',
        'vacuol': 'vacuole',
        'vacoule': 'vacuole',
        'endoplasm': 'endoplasm',
        'golbi': 'golgi',
        'centriole': 'centriole',
        'centril': 'centriole',
        
        // Physics typos
        'velocty': 'velocity',
        'veloctiy': 'velocity',
        'accelaration': 'acceleration',
        'acceleation': 'acceleration',
        'moementum': 'momentum',
        'momentem': 'momentum',
        'garvity': 'gravity',
        'gravty': 'gravity',
        'forcce': 'force',
        'trabsition': 'transition',
        'energt': 'energy',
        'pwoer': 'power',
        'frictio': 'friction',
        'presur': 'pressure',
        'temperat': 'temperature',
        
        // Chemistry typos
        'molecul': 'molecule',
        'molcule': 'molecule',
        'atm': 'atom',
        'elemnt': 'element',
        'elment': 'element',
        'elemet': 'element',
        'compund': 'compound',
        'compound': 'compound',
        'reactio': 'reaction',
        'oxidatio': 'oxidation',
        'reductio': 'reduction',
        'bondig': 'bonding',
        'bonding': 'bonding',
        'electro': 'electron',
        'proton': 'proton',
        'neutro': 'neutron'
    };
    
    // Replace typos with corrections - Word boundaries to avoid partial replacements
    for (const [typo, correct] of Object.entries(typoMap)) {
        const regex = new RegExp(`\\b${typo}\\b`, 'gi');
        corrected = corrected.replace(regex, correct);
    }
    
    // Fix common pattern typos (preserve case-insensitive matching)
    corrected = corrected
        .replace(/\bwh\s+at\b/gi, 'what')
        .replace(/\bwh\s+ich\b/gi, 'which')
        .replace(/\bho\s+w\b/gi, 'how')
        .replace(/\bwh\s+y\b/gi, 'why')
        .replace(/\bwh\s+ere\b/gi, 'where')
        .replace(/\bpo\s+wer\b/gi, 'power')
        .replace(/\bpower\s+house\b/gi, 'powerhouse')
        .replace(/\bordered\b/gi, 'organelle')
        .replace(/\bordanelle\b/gi, 'organelle');
    
    // Fix common character swaps (character-by-character fix)
    // For example: "hte" -> check if swapping helps
    const swapPatterns = [
        { from: /\bhte\b/gi, to: 'the' },
        { from: /\bnad\b/gi, to: 'nad' },
        { from: /\bfa\b/gi, to: 'for' },
        { from: /\bfo\b/gi, to: 'for' },
        { from: /\bpowe\b/gi, to: 'power' },
        { from: /\bpowre\b/gi, to: 'power' },
        { from: /\bpwoer\b/gi, to: 'power' },
        { from: /\bpwoers\b/gi, to: 'powers' },
        { from: /\bcell\b/gi, to: 'cell' },
        { from: /\bcel\b/gi, to: 'cell' },
        { from: /\belle\b/gi, to: 'cell' }
    ];
    
    for (const pattern of swapPatterns) {
        corrected = corrected.replace(pattern.from, pattern.to);
    }
    
    // ⭐ FUZZY MATCHING - More CONSERVATIVE: Only correct obvious NEET vocabulary typos
    // Skip fuzzy matching for: common English words, answer validation keywords, continuation keywords
    const skipFuzzyWords = [
        'is', 'are', 'am', 'be', 'the', 'a', 'an', 'and', 'or', 'but', 'if', 'on', 'at',
        'to', 'for', 'of', 'in', 'by', 'as', 'with', 'this', 'that', 'these', 'those',
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its',
        'option', 'answer', 'right', 'wrong', 'correct', 'incorrect', 'yes', 'no',
        'what', 'which', 'when', 'where', 'why', 'how', 'can', 'could', 'would', 'should',
        'do', 'does', 'did', 'have', 'has', 'had', 'will', 'shall', 'c', 'd', 'b', 'a',
        // ⭐ CONTINUATION KEYWORDS - Do NOT auto-correct these
        'more', 'explain', 'tell', 'elaborate', 'give', 'describe',
        // ⭐ UNITS & NAMES - Do NOT auto-correct these
        'newton', 'joule', 'pascal', 'hertz', 'watt', 'kelvin', 'ampere', 'volt', 'ohm',
        'einstein', 'name', 'unit'
    ];
    
    const commonBiologyWords = [
        'cell', 'nucleus', 'mitochondria', 'chloroplast', 'ribosome', 'golgi', 'lysosome',
        'vacuole', 'centriole', 'organelle', 'protein', 'enzyme', 'chromosome', 'gene',
        'dna', 'rna', 'glucose', 'photosynthesis', 'respiration', 'atp', 'nad', 'nadh',
        'powerhouse', 'membrane', 'eukaryotic', 'prokaryotic', 'cytoplasm', 'endoplasm'
    ];
    
    const commonPhysicsWords = [
        'velocity', 'acceleration', 'momentum', 'gravity', 'force', 'energy', 'power',
        'motion', 'friction', 'pressure', 'temperature', 'work', 'wave', 'light',
        'electron', 'proton', 'neutron', 'atom', 'molecule', 'reaction', 'oxidation'
    ];
    
    const commonChemistryWords = [
        'molecule', 'atom', 'element', 'compound', 'reaction', 'oxidation', 'reduction',
        'bonding', 'electron', 'proton', 'neutron', 'atp', 'bond', 'equilibrium',
        'thermodynamics', 'organic', 'hydrocarbon', 'acid', 'base', 'salt', 'ion'
    ];
    
    const allCommonWords = [...commonBiologyWords, ...commonPhysicsWords, ...commonChemistryWords];
    
    // Split text into words and fuzzy correct each one
    const words = corrected.split(/(\s+|[?.,!;:])/); // Keep spaces and punctuation
    const correctedWords = words.map(word => {
        // Skip if it's whitespace or punctuation
        if (/^[\s?.,!;:]*$/.test(word)) return word;
        
        // NEVER fuzzy match common English words or answer validation keywords
        if (skipFuzzyWords.includes(word.toLowerCase())) return word;
        
        // Only fuzzy match LONGER words (likely NEET vocabulary, 4+ characters)
        // This avoids "correcting" short valid words
        if (word.length >= 4) {
            return fuzzyCorrectWord(word, allCommonWords);
        }
        return word;
    });
    
    corrected = correctedWords.join('');
    
    return corrected;
}

// ⭐ DETECT REPEATED QUESTIONS - Returns true if current question is a repeat (85%+ similarity)
function isQuestionRepeated(currentQuestion, previousQuestionsWithKeywords) {
    if (!previousQuestionsWithKeywords || previousQuestionsWithKeywords.length === 0) {
        return false; // No previous questions to compare
    }
    
    // Normalize text for comparison
    const normalizeText = (text) => text.toLowerCase().trim();
    const currentNorm = normalizeText(currentQuestion);
    
    // Check for exact or near-exact matches
    for (const prevQ of previousQuestionsWithKeywords) {
        const prevNorm = normalizeText(prevQ.question);
        
        // Exact match
        if (currentNorm === prevNorm) {
            console.log(`[REPEAT DETECTED] Exact duplicate of: "${prevQ.question.substring(0, 60)}..."`);
            return true;
        }
        
        // Near-exact match (85%+ similarity)
        const similarity = calculateStringSimilarity(currentNorm, prevNorm);
        if (similarity >= 0.85) {
            console.log(`[REPEAT DETECTED] ${(similarity * 100).toFixed(1)}% similar to: "${prevQ.question.substring(0, 60)}..."`);
            return true;
        }
    }
    
    return false;
}

// Calculate string similarity (Levenshtein-based)
function calculateStringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = getEditDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}

function getEditDistance(s1, s2) {
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

// ⭐ IMPROVED KEYWORD EXTRACTION - Remove stop words, keep meaningful terms
// ⭐ NEW: DETECT EXPAND INTENT (e.g., "explain more", "tell me in detail")
// ⭐ NEW: DETECT CONTINUATION INTENT (user wants more info on SAME topic)
// Examples: "more", "tell me more", "explain in detail", "give more information"
function detectContinuationIntent(question) {
    const continuationKeywords = [
        'more',
        'explain',
        'tell me more',
        'more information',
        'explain in detail',
        'give more information',
        'elaborate',
        'go deeper',
        'more detail',
        'in detail',
        'further explanation',
        'tell more'
    ];

    const text = question.toLowerCase().trim();
    
    // Check exact phrases first
    const hasPhrase = continuationKeywords.some(phrase => text.includes(phrase));
    
    // For short inputs like just "more", check if it's ONLY continuation
    const isContinuationOnly = /^(more|explain|tell\s+me\s+more|elaborate|go\s+deeper|further)$/.test(text);
    
    return hasPhrase && isContinuationOnly;
}

function detectExpandIntent(question) {
    const expandKeywords = [
        'explain', 'more', 'detail', 'elaborate', 'further',
        'why', 'how', 'information', 'tell', 'give', 'describe',
        'deeper', 'thoroughly', 'step', 'process', 'example', 'context'
    ];

    const text = question.toLowerCase();
    const words = text.split(/\s+/);
    
    const hasExpand = words.some(word => expandKeywords.includes(word));
    const hasMore = /explain\s+more|tell\s+me\s+more|more\s+info|more\s+detail|in\s+detail|step\s+by\s+step/.test(text);
    
    return hasExpand || hasMore;
}

function extractMeaningfulKeywords(text) {
    // Stop words to remove
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
        'is', 'are', 'am', 'be', 'been', 'being', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'have', 'has', 'had', 'can', 'may', 'might', 'must', 'shall',
        'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
        'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
        'my', 'your', 'his', 'her', 'its', 'our', 'their',
        'as', 'if', 'so', 'than', 'then', 'not', 'no', 'yes', 'very', 'just',
        'me', 'him', 'her', 'us', 'them', 'about', 'tell', 'also', 'more', 'most', 'some',
        'give', 'given', 'define', 'explain', 'describe', 'discuss', 'mention', 'state',
        'option'
    ]);
    
    // ⭐ STEP 1: Separate MCQ options from main question
    // Match pattern: "A) text B) text C) text D) text" (case-insensitive)
    const mcqMatch = text.match(/[A-Da-d]\)/);
    let mainQuestion = text;
    let optionTexts = [];
    
    if (mcqMatch) {
        // MCQ found - split into main question and options
        const mcqStartIndex = mcqMatch.index;
        mainQuestion = text.substring(0, mcqStartIndex).trim();
        const mcqSection = text.substring(mcqStartIndex);
        
        // Extract individual options: A) option1 B) option2 C) option3 D) option4
        // Handles both "A) text" and "A) "quoted text"" formats
        // ✅ FIX: Use non-greedy matching .+? instead of [^A-Da-d)...] to capture ALL options including those starting with a-d
        const optionRegex = /[A-Da-d]\)\s*["']?(.+?)["']?\s*(?=[A-Da-d]\)|$)/g;
        let match;
        while ((match = optionRegex.exec(mcqSection)) !== null) {
            const optionText = match[1].trim();
            if (optionText.length > 0) {
                optionTexts.push(optionText);
            }
        }
    }
    
    // ⭐ STEP 2: Extract keywords from main question
    const mainKeywords = mainQuestion
        .toLowerCase()
        .replace(/[?.,!;:()""'']/g, '')  // Remove all quotes and punctuation
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word))
        .map(w => w.trim());
    
    // ⭐ STEP 3: Extract keywords from MCQ options
    const optionKeywords = [];
    for (const option of optionTexts) {
        const words = option
            .toLowerCase()
            .replace(/[?.,!;:()""'']/g, '')  // Remove all quotes and punctuation
            .split(/\s+/)
            .filter(word => word.length > 0 && !stopWords.has(word));
        
        // Keep multi-word options as single keywords (e.g., "nitrous oxide")
        if (words.length > 1) {
            const multiWord = words.join(' ');
            if (multiWord.length > 2) {
                optionKeywords.push(multiWord);
            }
        } else if (words.length === 1 && words[0].length > 2) {
            optionKeywords.push(words[0]);
        }
    }
    
    // ⭐ STEP 4: Combine all keywords and remove duplicates
    const allKeywords = [...mainKeywords, ...optionKeywords];
    return [...new Set(allKeywords)];
}

// Extract all keywords (no filtering of stop words)
function extractKeywords(text) {
    return text
        .toLowerCase()
        .replace(/[?.,!]/g, "")
        .split(/\s+/)
        .filter(word => word.length > 2); // Keep all words, just filter by length
}

// ========================================
// ⭐ NEW FEATURE: EXPLICIT KEYWORD COMPARISON
// ========================================
// Extracts key concepts from current question
// Compares with ALL previous questions
// Determines if it's a FOLLOW_UP or NEW QUESTION based on keyword overlap
// Logs detailed analysis for transparency
// Calculate keyword overlap between two messages
function calculateKeywordOverlap(previousText, currentText) {
    const prevKeywords = new Set(extractKeywords(previousText));
    const currKeywords = new Set(extractKeywords(currentText));
    
    if (prevKeywords.size === 0 || currKeywords.size === 0) return 0;
    
    // Count matching keywords
    let matches = 0;
    for (let keyword of currKeywords) {
        if (prevKeywords.has(keyword)) matches++;
    }
    
    // ENHANCED: Check for key concept keywords that indicate same topic
    const conceptKeywords = {
        // Organelles
        organelle: ['nucleus', 'mitochondria', 'golgi', 'ribosome', 'chloroplast', 'endoplasmic', 'lysosome'],
        nucleus: ['organelle', 'dna', 'chromosome', 'genetic', 'control'],
        mitochondria: ['powerhouse', 'energy', 'atp', 'cell', 'organelle'],
        golgi: ['organelle', 'cell', 'apparatus', 'transport', 'protein'],
        ribosome: ['organelle', 'protein', 'synthesis', 'cell'],
        powerhouse: ['mitochondria', 'energy', 'cell', 'organelle'],
        // Photosynthesis
        photosynthesis: ['chloroplast', 'glucose', 'light', 'energy', 'plant'],
        chloroplast: ['photosynthesis', 'plant', 'light', 'energy', 'glucose'],
        // Respiration
        respiration: ['mitochondria', 'glucose', 'energy', 'atp', 'oxygen'],
        // Genetics
        dna: ['gene', 'chromosome', 'protein', 'genetic', 'nucleus'],
        chromosome: ['dna', 'gene', 'genetic', 'nucleus'],
        gene: ['dna', 'chromosome', 'protein', 'genetic'],
        // Proteins & Enzymes
        enzyme: ['protein', 'reaction', 'catalyst', 'substrate', 'activity'],
        protein: ['enzyme', 'synthesis', 'ribosome', 'gene', 'amino'],
        // Physics
        gravity: ['mass', 'weight', 'force', 'acceleration', 'fall'],
        velocity: ['speed', 'acceleration', 'motion', 'displacement'],
        motion: ['velocity', 'acceleration', 'force', 'speed'],
        // Chemistry
        atom: ['electron', 'proton', 'nucleus', 'structure', 'element'],
        bonding: ['electron', 'molecule', 'ionic', 'covalent', 'atom']
    };
    
    // Check if either message contains key concepts
    let conceptMatches = 0;
    const prevText = previousText.toLowerCase();
    const currText = currentText.toLowerCase();
    
    for (const [concept, relatedWords] of Object.entries(conceptKeywords)) {
        const conceptInPrev = prevText.includes(concept);
        const conceptInCurr = currText.includes(concept);
        
        if (conceptInPrev && conceptInCurr) {
            conceptMatches += 3; // Heavy weight for matching concepts
        }
        
        // Check if related words match
        if (conceptInPrev || conceptInCurr) {
            for (const related of relatedWords) {
                if (prevText.includes(related) && currText.includes(related)) {
                    conceptMatches += 2;
                }
            }
        }
    }
    
    // Calculate overlap percentage (based on current message keywords)
    const baseOverlap = (matches / currKeywords.size) * 100;
    const conceptBoost = Math.min(conceptMatches * 5, 40); // Boost up to 40% for concept matches
    const totalOverlap = Math.min(baseOverlap + conceptBoost, 100);
    
    return {
        matches: matches,
        currentKeywords: currKeywords.size,
        overlapPercent: totalOverlap,
        conceptMatches: conceptMatches,
        isFollowUp: totalOverlap >= 65 // STRICT: 65% overlap required to be follow-up
    };
}

// Improved question detection
function isQuestion(msg) {
    msg = msg.trim().toLowerCase();

    // 1. Question mark
    if (msg.endsWith("?")) return true;

    // 2. Classic question words
    const questionWords = [
        "what","why","how","which","when","where","whom",
        "is","are","do","does","can","could","should",
        "explain","define","differentiate","list"
    ];

    const first = msg.split(" ")[0];
    if (questionWords.includes(first)) return true;

    // 3. MCQ pattern - enhanced detection
    // Check for A) B) C) D) or A. B. C. D. patterns
    const mcqPatterns = [
        /\b[a-d]\)\s/gi,           // A) B) C) D)
        /\b[a-d]\.\s/gi,           // A. B. C. D.
        /\([a-d]\)/gi,             // (A) (B) (C) (D)
        /\b[1-4]\)\s/g,            // 1) 2) 3) 4)
        /\b[1-4]\.\s/g             // 1. 2. 3. 4.
    ];
    
    let totalMatches = 0;
    for (const pattern of mcqPatterns) {
        const matches = msg.match(pattern);
        if (matches) totalMatches += matches.length;
    }
    
    // Comprehensive NEET terms (Physics, Chemistry, Biology)
    const neetTerms = [
        // Physics
        "velocity", "acceleration", "force", "motion", "mass", "energy", "momentum", 
        "displacement", "friction", "tension", "gravity", "pressure", "work", "power",
        "kinetic", "potential", "thermodynamics", "wave", "optics", "current", "voltage",
        "magnetic", "electric", "circuit", "resistance", "capacitance", "inductor",
        
        // Chemistry
        "atom", "molecule", "element", "compound", "reaction", "chemical", "bond",
        "acid", "base", "salt", "ph", "oxidation", "reduction", "ion", "electron",
        "neutron", "proton", "periodic", "catalyst", "equilibrium", "mole", "molarity",
        "organic", "inorganic", "hydrocarbon", "alkane", "alkene", "benzene",
        
        // Biology (Botany + Zoology)
        "cell", "dna", "rna", "protein", "enzyme", "mitochondria", "chloroplast",
        "photosynthesis", "respiration", "gene", "chromosome", "mitosis", "meiosis",
        "tissue", "organ", "muscle", "neuron", "hormone", "blood", "heart", "kidney",
        "plant", "flower", "root", "stem", "leaf", "pollination", "seed", "fruit",
        "animal", "vertebrate", "invertebrate", "ecosystem", "evolution", "species"
    ];
    
    const hasNEETTerms = neetTerms.some(term => msg.includes(term));
    
    // ⭐ CRITICAL RULE: If MCQ options + NEET terms → ACADEMIC
    if (totalMatches >= 2 && hasNEETTerms) {
        console.log(`[ACADEMIC DETECTED] MCQ with NEET terms: ${totalMatches} options found`);
        return true;
    }
    
    // If we find 2+ option markers (even without NEET terms)
    if (totalMatches >= 2) return true;
    
    // If NEET terms present (even without MCQ)
    if (hasNEETTerms) return true;

    // 4. Hidden academic question phrases
    const academicTriggers = [
        "define",
        "explain",
        "differentiate",
        "give",
        "state",
        "mention",
        "choose",
        "find",
        "identify",
        "what is",
        "name the",
        "si unit",
        "unit of",
        "represents",
        "represent",
        "calculate",
        "compute",
        "solve",
        "derive",
        "prove",
        "show that",
        "determine",
        "compare",
        "distinguish",
        "illustrate",
        "describe",
        "list",
        "write",
        "draw",
        "sketch",
        "which of the following",
        "correct option",
        "incorrect statement"
    ];

    if (academicTriggers.some(w => msg.includes(w))) return true;

    return false;
}

// ========================================
// LESSON & TOPIC MAPPING FOR NCERT
// ========================================
function getLessonInfo(topic, subject) {
    const topic_lower = topic.toLowerCase();
    
    // Biology Lessons
    const biologyLessons = {
        "mitochondria": {
            lesson: "Cell Biology",
            ncert: "Cell: The Unit of Life",
            specificTopic: "Cell Organelles (especially Mitochondria)",
            chapter: "Cell"
        },
        "chloroplast": {
            lesson: "Cell Biology",
            ncert: "Cell: The Unit of Life",
            specificTopic: "Cell Organelles (especially Chloroplast)",
            chapter: "Cell"
        },
        "ribosome": {
            lesson: "Cell Biology",
            ncert: "Cell: The Unit of Life",
            specificTopic: "Cell Organelles (Ribosomes)",
            chapter: "Cell"
        },
        "nucleus": {
            lesson: "Cell Biology",
            ncert: "Cell: The Unit of Life",
            specificTopic: "Cell Organelles (Nucleus)",
            chapter: "Cell"
        },
        "golgi": {
            lesson: "Cell Biology",
            ncert: "Cell: The Unit of Life",
            specificTopic: "Cell Organelles (Golgi Body)",
            chapter: "Cell"
        },
        "photosynthesis": {
            lesson: "Photosynthesis",
            ncert: "Photosynthesis in Higher Plants",
            specificTopic: "Light Reactions and Dark Reactions",
            chapter: "Photosynthesis"
        },
        "respiration": {
            lesson: "Respiration",
            ncert: "Respiration in Plants",
            specificTopic: "Aerobic and Anaerobic Respiration",
            chapter: "Respiration"
        },
        "dna": {
            lesson: "Molecular Biology",
            ncert: "Molecular Basis of Inheritance",
            specificTopic: "DNA Structure and Replication",
            chapter: "Molecular Basis"
        },
        "rna": {
            lesson: "Molecular Biology",
            ncert: "Molecular Basis of Inheritance",
            specificTopic: "RNA Structure and Function",
            chapter: "Molecular Basis"
        },
        "gene": {
            lesson: "Inheritance",
            ncert: "Inheritance and Variation",
            specificTopic: "Genes and Alleles",
            chapter: "Inheritance"
        },
        "mitosis": {
            lesson: "Cell Division",
            ncert: "Cell Cycle and Cell Division",
            specificTopic: "Mitosis (Equational Division)",
            chapter: "Cell Division"
        },
        "meiosis": {
            lesson: "Cell Division",
            ncert: "Cell Cycle and Cell Division",
            specificTopic: "Meiosis (Reduction Division)",
            chapter: "Cell Division"
        }
    };

    // Physics Lessons
    const physicsLessons = {
        "motion": {
            lesson: "Kinematics",
            ncert: "Motion in a Straight Line",
            specificTopic: "Velocity, Acceleration, and Displacement",
            chapter: "Motion"
        },
        "force": {
            lesson: "Newton's Laws",
            ncert: "Laws of Motion",
            specificTopic: "Newton's First, Second, and Third Laws",
            chapter: "Laws of Motion"
        },
        "energy": {
            lesson: "Work and Energy",
            ncert: "Work, Energy and Power",
            specificTopic: "Kinetic and Potential Energy",
            chapter: "Work Energy"
        },
        "momentum": {
            lesson: "Momentum",
            ncert: "Laws of Motion",
            specificTopic: "Conservation of Momentum",
            chapter: "Laws of Motion"
        },
        "gravity": {
            lesson: "Gravitation",
            ncert: "Gravitation",
            specificTopic: "Newton's Law of Universal Gravitation",
            chapter: "Gravitation"
        },
        "wave": {
            lesson: "Waves",
            ncert: "Waves",
            specificTopic: "Types of Waves and Wave Properties",
            chapter: "Waves"
        },
        "optics": {
            lesson: "Light",
            ncert: "Ray Optics and Optical Instruments",
            specificTopic: "Reflection, Refraction, and Lenses",
            chapter: "Optics"
        },
        "electricity": {
            lesson: "Current Electricity",
            ncert: "Current Electricity",
            specificTopic: "Electric Current and Resistance",
            chapter: "Electricity"
        },
        "magnetism": {
            lesson: "Magnetism",
            ncert: "Magnetism and Matter",
            specificTopic: "Magnetic Fields and Forces",
            chapter: "Magnetism"
        }
    };

    // Chemistry Lessons
    const chemistryLessons = {
        "atom": {
            lesson: "Atomic Structure",
            ncert: "Structure of Atom",
            specificTopic: "Bohr's Model and Quantum Numbers",
            chapter: "Atomic Structure"
        },
        "bond": {
            lesson: "Chemical Bonding",
            ncert: "Chemical Bonding and Molecular Structure",
            specificTopic: "Ionic, Covalent, and Coordinate Bonding",
            chapter: "Chemical Bonding"
        },
        "reaction": {
            lesson: "Chemical Reactions",
            ncert: "Redox Reactions",
            specificTopic: "Types of Chemical Reactions",
            chapter: "Redox"
        },
        "acid": {
            lesson: "Acids and Bases",
            ncert: "Equilibrium",
            specificTopic: "pH, Buffer Solutions, and Acid-Base Reactions",
            chapter: "Equilibrium"
        },
        "redox": {
            lesson: "Redox Reactions",
            ncert: "Redox Reactions",
            specificTopic: "Oxidation and Reduction",
            chapter: "Redox"
        },
        "organic": {
            lesson: "Organic Chemistry",
            ncert: "Organic Chemistry",
            specificTopic: "Hydrocarbons and Functional Groups",
            chapter: "Organic"
        },
        "periodic": {
            lesson: "Periodic Table",
            ncert: "Classification of Elements and Periodicity in Properties",
            specificTopic: "Periodic Trends and Properties",
            chapter: "Periodic"
        }
    };

    // Determine which lesson set to use based on subject
    let lessons = {};
    if (subject.includes("Biology")) {
        lessons = biologyLessons;
    } else if (subject.includes("Physics")) {
        lessons = physicsLessons;
    } else if (subject.includes("Chemistry")) {
        lessons = chemistryLessons;
    }

    // Search for matching lesson
    for (const [key, value] of Object.entries(lessons)) {
        if (topic_lower.includes(key) || topic_lower.includes(key)) {
            return value;
        }
    }

    // Default fallback
    return {
        lesson: "General NEET Topic",
        ncert: "NCERT Science",
        specificTopic: topic,
        chapter: "General"
    };
}

function extractTopic(text) {
    const words = text.replace("?", "").split(" ");

    // Example: "what is mitochondria"
    if (words.includes("what") && words.includes("is")) {
        return words[words.length - 1];
    }

    // Example: "explain photosynthesis"
    return words[words.length - 1];
}

// ========================================
// SUBJECT DETECTION FUNCTION
// ========================================
// Identifies which subject (Biology, Physics, Chemistry) a question belongs to
function detectSubject(text) {
    const lowerText = text.toLowerCase();

    // Physics keywords
    const physicsKeywords = [
        "velocity", "acceleration", "force", "motion", "mass", "energy", "momentum",
        "displacement", "friction", "tension", "gravity", "pressure", "work", "power",
        "kinetic", "potential", "thermodynamics", "wave", "optics", "current", "voltage",
        "magnetic", "electric", "circuit", "resistance", "capacitance", "inductor",
        "mechanics", "kinematics", "dynamics", "statics", "gravitation", "electricity",
        "magnetism", "sound", "light", "reflection", "refraction", "lens", "mirror",
        "newton", "joule", "watt", "tesla", "ohm", "coulomb", "hertz"
    ];

    // Chemistry keywords
    const chemistryKeywords = [
        "atom", "molecule", "element", "compound", "reaction", "chemical", "bond",
        "acid", "base", "salt", "ph", "oxidation", "reduction", "ion", "electron",
        "neutron", "proton", "periodic", "catalyst", "equilibrium", "mole", "molarity",
        "organic", "inorganic", "hydrocarbon", "alkane", "alkene", "benzene", "ester",
        "polymer", "isomer", "valence", "electronegativity", "thermochemistry",
        "stoichiometry", "redox", "ester", "amide", "carboxylic", "ether", "hydroxyl"
    ];

    // Biology keywords
    const biologyKeywords = [
        "cell", "dna", "rna", "protein", "enzyme", "mitochondria", "chloroplast",
        "photosynthesis", "respiration", "gene", "chromosome", "mitosis", "meiosis",
        "tissue", "organ", "muscle", "neuron", "hormone", "blood", "heart", "kidney",
        "plant", "flower", "root", "stem", "leaf", "pollination", "seed", "fruit",
        "animal", "vertebrate", "invertebrate", "ecosystem", "evolution", "species",
        "organism", "cell", "biology", "zoology", "botany", "genetics", "heredity",
        "reproduction", "photosynthetic", "metabolic", "metabolism", "digestion"
    ];

    // Count keyword matches for each subject
    const physicsMatches = physicsKeywords.filter(kw => lowerText.includes(kw)).length;
    const chemistryMatches = chemistryKeywords.filter(kw => lowerText.includes(kw)).length;
    const biologyMatches = biologyKeywords.filter(kw => lowerText.includes(kw)).length;

    // Return the subject with the most matches
    if (physicsMatches > chemistryMatches && physicsMatches > biologyMatches && physicsMatches > 0) {
        return "Physics";
    } else if (chemistryMatches > biologyMatches && chemistryMatches > 0) {
        return "Chemistry";
    } else if (biologyMatches > 0) {
        return "Biology";
    }

    // Default based on keywords
    if (lowerText.includes("physics") || lowerText.includes("kinematics")) return "Physics";
    if (lowerText.includes("chemistry") || lowerText.includes("organic")) return "Chemistry";
    if (lowerText.includes("biology") || lowerText.includes("cell")) return "Biology";

    return "General NEET";
}

function classifyMessage(message, lastTopic = null, previousQuestions = []) {
    const text = message.toLowerCase().trim();

    // -----------------------------
    // 1. CASUAL CHECK
    // -----------------------------
    const CASUAL_WORDS = [
        "hi", "hello", "hai", "hey", "yo", "sup", "what's up",
        "how are you", "ok", "okay", "thanks", "thank you", 
        "bye", "good morning", "good night", "hii", "hiiii"
    ];

    const isCasual = CASUAL_WORDS.some(w => text.startsWith(w) || text === w);
    if (isCasual) {
        return {
            type: "CASUAL",
            topic: null,
            reason: "Matched casual greeting/phrase"
        };
    }

    // ✅ NEW: ANSWER CONFIRMATION CHECK
    // Detect when user is asking if their answer is correct
    // Examples: "Is this correct?", "I think the answer is C) Mitochondria. Is this correct?"
    //           "the option c mithochondria is right" → Answer confirmation!
    // These should be FOLLOW_UP questions, not new topics
    const ANSWER_CONFIRMATION_PATTERNS = [
        /is this correct/i,
        /am i right/i,
        /is that right/i,
        /is that correct/i,
        /is that true/i,
        /i think the answer is/i,
        /my answer is/i,
        /answer is correct/i,
        /correct answer/i,
        /did i get it right/i,
        /is my answer correct/i,
        /is my answer right/i,
        /option [a-d]/i,            // "option c" indicates they're choosing an option
        /answer [a-d]/i,            // "answer a" or "answer c"
        /is right/i,                // "is right" - checking if right
        /is correct/i,              // "is correct" - checking if correct  
        /right answer/i,            // "right answer"
        /correct option/i,          // "correct option"
        /[a-d]\)/                   // "C)" format
    ];

    const isAnswerConfirmation = ANSWER_CONFIRMATION_PATTERNS.some(pattern => pattern.test(text));
    if (isAnswerConfirmation && (lastTopic || (previousQuestions && previousQuestions.length > 0))) {
        console.log(`[ANSWER CONFIRMATION] User checking if answer is correct: "${text}"`);
        return {
            type: "FOLLOW_UP",
            topic: lastTopic || "answer_check",  // Use lastTopic if available, else generic
            reason: "User confirming/checking their answer"
        };
    }

    // -----------------------------
    // 2. CONCEPT CONTINUATION CHECK (IMPROVED)
    // If asking about a specific concept/organelle that was mentioned in previous questions,
    // treat it as a FOLLOW-UP (e.g., Q1 mentions "nucleus" as option, Q3 asks "what is nucleus")
    // Also catches answer confirmations like "option c mitochondria is right"
    // because "mitochondria" appears in previous questions
    // NOW WORKS: Even without lastTopic (removes && lastTopic requirement)
    // This ensures "the option c mithochondria is right answers" matches because "mitochondria" was mentioned before
    // -----------------------------
    if (previousQuestions && previousQuestions.length > 0) {
        const currentTopicWords = new Set(extractKeywords(text));
        
        // Check if any word from current question appears in previous questions
        // These are likely follow-ups asking about specific concepts mentioned before
        let conceptMatch = false;
        let matchedConcept = null;
        
        for (const prevQ of previousQuestions) {
            const prevQText = prevQ.toLowerCase();
            for (const word of currentTopicWords) {
                // Skip generic/utility words - more comprehensive list
                const skipWords = [
                    'what', 'is', 'the', 'a', 'an', 'do', 'does', 'can', 'you', 'are', 
                    'i', 'it', 'in', 'of', 'to', 'for', 'this', 'that', 'right', 'correct', 
                    'option', 'answer', 'my', 'me', 'or', 'on', 'at', 'by', 'as', 'be', 'we'
                ];
                if (skipWords.includes(word)) {
                    continue;
                }
                
                // Check if this topic word appears in previous questions (reduced length from 3 to 2)
                if (prevQText.includes(word) && word.length > 2) {
                    conceptMatch = true;
                    matchedConcept = word;
                    console.log(`[CONCEPT MATCH] Current mentions "${word}" which was in previous questions`);
                    break;
                }
            }
            if (conceptMatch) break;
        }
        
        // If asking about a concept mentioned before, it's a follow-up
        if (conceptMatch) {
            return {
                type: "FOLLOW_UP",
                topic: lastTopic || "general",  // Use lastTopic if available, else "general"
                reason: `Follow-up/Answer check: Question mentions "${matchedConcept}" from previous question(s)`
            };
        }
    }

    // -----------------------------
    // 3. FOLLOW-UP CHECK (compare against ALL previous questions)
    // BUT: Do NOT classify repeats or near-identical questions as follow-ups
    // Near-identical (80%+ overlap) should be treated as NEW questions, not continuations
    // Only classify as FOLLOW_UP if it's related but clearly different from previous questions
    // -----------------------------
    if (previousQuestions && previousQuestions.length > 0 && lastTopic) {
        // Check overlap with ALL previous questions
        let maxOverlap = 0;
        let matchedQuestion = null;
        let maxOverlapQuestion = null;
        
        for (const prevQ of previousQuestions) {
            const overlap = calculateKeywordOverlap(prevQ, text);
            if (overlap.overlapPercent > maxOverlap) {
                maxOverlap = overlap.overlapPercent;
                matchedQuestion = {
                    question: prevQ.substring(0, 50) + '...',
                    overlap: overlap
                };
                maxOverlapQuestion = prevQ;
            }
        }
        
        // ⭐ CRITICAL FIX: If this is a near-identical repeat (80%+ overlap), treat as NEW question, not follow-up
        // This prevents "Q1 → Q1 again" from being classified as a subtopic
        if (maxOverlap >= 80) {
            // This is essentially the same question asked again - treat as NEW
            // Don't classify as FOLLOW_UP
            return {
                type: "ACADEMIC",
                topic: extractTopic(text),
                reason: `Repeated or near-identical question (${maxOverlap.toFixed(0)}% overlap with previous) - treating as NEW question`
            };
        }
        
        // Only check for actual follow-ups (related but different questions)
        // Short contextual questions need higher overlap threshold to be considered follow-ups
        const wordCount = text.split(/\s+/).length;
        const isShortQuestion = wordCount <= 5;
        const threshold = isShortQuestion ? 75 : 65; // STRICTER: Require 65-75% overlap to be follow-up
        
        // Also check for contextual question patterns like "what is X" where X was in previous question
        const contextualPatterns = [
            /^what is (\w+)$/,           // "what is acceleration"
            /^what are (\w+)$/,          // "what are they"
            /^which (\w+)$/,             // "which one"
            /^how (\w+)$/,               // "how much"
            /^why (\w+)$/,               // "why that"
            /^can you explain (\w+)$/    // "can you explain that"
        ];
        
        let isContextualQuestion = false;
        for (const pattern of contextualPatterns) {
            const match = text.match(pattern);
            if (match) {
                // Check if the captured word(s) exist in any previous question
                const capturedWord = match[1].toLowerCase();
                for (const prevQ of previousQuestions) {
                    if (prevQ.toLowerCase().includes(capturedWord)) {
                        isContextualQuestion = true;
                        break;
                    }
                }
                if (isContextualQuestion) break;
            }
        }
        
        // Only classify as FOLLOW_UP if overlap is in the "related but different" range
        // and it's not just a repeat
        if ((maxOverlap >= threshold && maxOverlap < 80) || isContextualQuestion) {
            return {
                type: "FOLLOW_UP",
                topic: lastTopic,
                reason: `Follow-up (${matchedQuestion.overlap.matches}/${matchedQuestion.overlap.currentKeywords} keywords match, ${maxOverlap.toFixed(0)}% overlap${isContextualQuestion ? ', contextual question detected' : ''} with: "${matchedQuestion.question}")`
            };
        }
    }


    // -----------------------------
    // 3. ACADEMIC CHECK (using improved isQuestion)
    // -----------------------------
    if (isQuestion(text)) {
        const topic = extractTopic(text);

        return {
            type: "ACADEMIC",
            topic,
            reason: "Matched question patterns (academic)"
        };
    }

    // -----------------------------
    // 4. DEFAULT = NORMAL MESSAGE
    // -----------------------------
    return {
        type: "NORMAL",
        topic: null,
        reason: "No casual, academic, or follow-up patterns detected"
    };
}

// ========================================
// END MESSAGE CLASSIFICATION
// ========================================

// ========================================
// IMAGE PROCESSING FUNCTIONS
// ========================================

/**
 * Extract text from image using OCR
 */
async function extractTextFromImage(imageBase64) {
    try {
        console.log("[OCR] Starting text extraction...");
        
        // Convert base64 to buffer
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Use Tesseract.js for OCR
        const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
            logger: m => console.log(`[OCR Progress] ${m.status}: ${m.progress}`)
        });
        
        console.log("[OCR] Extracted text:", text);
        return text.trim();
    } catch (error) {
        console.error("[OCR] Error:", error);
        return "";
    }
}

/**
 * Extract only the diagram/illustration from image
 * MANDATORY: Removes ALL text, options, borders, backgrounds
 * ONLY keeps: blocks, arrows, force directions, ground lines, angle markings
 */
async function extractDiagramFromImage(imageBase64) {
    try {
        console.log("[DIAGRAM] Starting STRICT diagram extraction...");
        
        // Convert base64 to buffer
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Step 1: Use OCR to detect text regions that must be excluded
        const ocrResult = await Tesseract.recognize(buffer, 'eng', {
            logger: m => console.log(`[DIAGRAM OCR] ${m.status}: ${Math.round(m.progress * 100)}%`)
        });
        
        const words = ocrResult.data.words || [];
        
        console.log(`[DIAGRAM] Found ${words.length} text regions to exclude`);
        
        // Load image with sharp
        const image = sharp(buffer);
        const metadata = await image.metadata();
        
        console.log(`[DIAGRAM] Image dimensions: ${metadata.width}x${metadata.height}`);
        
        // Get image data for processing
        const { data, info } = await image
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        // Load image with canvas for edge detection
        const canvas = createCanvas(info.width, info.height);
        const ctx = canvas.getContext('2d');
        const img = await loadImage(buffer);
        ctx.drawImage(img, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, info.width, info.height);
        
        // Step 2: Detect diagram region while EXCLUDING text regions
        const { diagramRegion, hasDiagram } = detectDiagramRegionStrict(
            imageData, 
            info.width, 
            info.height, 
            words
        );
        
        if (!hasDiagram) {
            console.log("[DIAGRAM] No clear diagram detected after text exclusion");
            // Try to find ANY visual content region as fallback
            const fallbackRegion = findVisualContentRegion(imageData, info.width, info.height);
            if (fallbackRegion) {
                console.log("[DIAGRAM] Using fallback visual region");
                const croppedBuffer = await sharp(buffer)
                    .extract({ 
                        left: Math.round(fallbackRegion.left), 
                        top: Math.round(fallbackRegion.top), 
                        width: Math.round(fallbackRegion.width), 
                        height: Math.round(fallbackRegion.height) 
                    })
                    .toBuffer();
                return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
            }
            return imageBase64;
        }
        
        // Minimal padding to avoid including text at edges
        const padding = 5;
        const cropLeft = Math.max(0, diagramRegion.left - padding);
        const cropTop = Math.max(0, diagramRegion.top - padding);
        const cropWidth = Math.min(info.width - cropLeft, diagramRegion.width + 2 * padding);
        const cropHeight = Math.min(info.height - cropTop, diagramRegion.height + 2 * padding);
        
        console.log(`[DIAGRAM] Cropping region (text-free): ${cropLeft},${cropTop} ${cropWidth}x${cropHeight}`);
        
        const croppedBuffer = await sharp(buffer)
            .extract({ 
                left: Math.round(cropLeft), 
                top: Math.round(cropTop), 
                width: Math.round(cropWidth), 
                height: Math.round(cropHeight) 
            })
            .toBuffer();
        
        // Step 3: Verify the cropped image doesn't contain text
        const verifyResult = await Tesseract.recognize(croppedBuffer, 'eng');
        const remainingText = verifyResult.data.text.trim();
        
        if (remainingText.length > 10) {
            console.log(`[DIAGRAM] ⚠️ WARNING: Cropped image still contains text: "${remainingText.substring(0, 50)}..."`);
            console.log("[DIAGRAM] Attempting aggressive re-crop...");
            
            // Try more aggressive cropping
            const aggressiveRegion = findPureVisualRegion(imageData, info.width, info.height, words);
            if (aggressiveRegion) {
                const aggressiveBuffer = await sharp(buffer)
                    .extract({ 
                        left: Math.round(aggressiveRegion.left), 
                        top: Math.round(aggressiveRegion.top), 
                        width: Math.round(aggressiveRegion.width), 
                        height: Math.round(aggressiveRegion.height) 
                    })
                    .toBuffer();
                
                console.log("[DIAGRAM] Aggressive re-crop completed");
                return `data:image/png;base64,${aggressiveBuffer.toString('base64')}`;
            }
        }
        
        // Convert back to base64
        const croppedBase64 = `data:image/png;base64,${croppedBuffer.toString('base64')}`;
        
        console.log("[DIAGRAM] ✅ Extraction complete - text-free diagram");
        return croppedBase64;
        
    } catch (error) {
        console.error("[DIAGRAM] Error:", error);
        return imageBase64; // Return original on error
    }
}

/**
 * Detect diagram region STRICTLY - excluding ALL text regions
 * Returns bounding box of ONLY the visual diagram elements
 */
function detectDiagramRegionStrict(imageData, width, height, textWords) {
    const data = imageData.data;
    
    // Create exclusion mask for text regions
    const textMask = Array(height).fill(0).map(() => Array(width).fill(false));
    
    // Mark all text regions in the mask (with expansion to ensure full exclusion)
    for (const word of textWords) {
        const bbox = word.bbox;
        const expansion = 15; // Expand text bounding boxes to ensure complete exclusion
        
        const x0 = Math.max(0, Math.floor(bbox.x0 - expansion));
        const y0 = Math.max(0, Math.floor(bbox.y0 - expansion));
        const x1 = Math.min(width, Math.ceil(bbox.x1 + expansion));
        const y1 = Math.min(height, Math.ceil(bbox.y1 + expansion));
        
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                if (y < height && x < width) {
                    textMask[y][x] = true;
                }
            }
        }
    }
    
    console.log("[DIAGRAM] Text mask created, excluded regions marked");
    
    // Find bounding box of non-white, non-text pixels (visual content only)
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let visualPixelCount = 0;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Skip if this is a text region
            if (textMask[y][x]) continue;
            
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            // Check if pixel is not white (visual content) - stricter threshold
            if (r < 250 || g < 250 || b < 250) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                visualPixelCount++;
            }
        }
    }
    
    if (visualPixelCount < 100) {
        console.log("[DIAGRAM] Insufficient visual content found after text exclusion");
        return { diagramRegion: { left: 0, top: 0, width: width, height: height }, hasDiagram: false };
    }
    
    const diagramRegion = {
        left: minX,
        top: minY,
        width: maxX - minX,
        height: maxY - minY
    };
    
    const areaRatio = (diagramRegion.width * diagramRegion.height) / (width * height);
    const hasDiagram = visualPixelCount > 100 && areaRatio < 0.8 && areaRatio > 0.01;
    
    console.log(`[DIAGRAM] Strict detection: visualPixels=${visualPixelCount}, areaRatio=${areaRatio.toFixed(3)}, hasDiagram=${hasDiagram}`);
    
    return { diagramRegion, hasDiagram };
}

/**
 * Find visual content region (fallback method)
 */
function findVisualContentRegion(imageData, width, height) {
    const data = imageData.data;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let found = false;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            // Look for darker pixels (likely diagram elements)
            if (r < 200 || g < 200 || b < 200) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                found = true;
            }
        }
    }
    
    if (!found) return null;
    
    return {
        left: minX,
        top: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

/**
 * Find pure visual region (most aggressive cropping)
 */
function findPureVisualRegion(imageData, width, height, textWords) {
    const data = imageData.data;
    
    // Create comprehensive exclusion mask
    const excludeMask = Array(height).fill(0).map(() => Array(width).fill(false));
    
    // Exclude ALL text regions with large expansion
    for (const word of textWords) {
        const bbox = word.bbox;
        const expansion = 30; // Very aggressive expansion
        
        const x0 = Math.max(0, Math.floor(bbox.x0 - expansion));
        const y0 = Math.max(0, Math.floor(bbox.y0 - expansion));
        const x1 = Math.min(width, Math.ceil(bbox.x1 + expansion));
        const y1 = Math.min(height, Math.ceil(bbox.y1 + expansion));
        
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                if (y < height && x < width) {
                    excludeMask[y][x] = true;
                }
            }
        }
    }
    
    // Find remaining visual content
    let minX = width, minY = height, maxX = 0, maxY = 0;
    let found = false;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (excludeMask[y][x]) continue;
            
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            if (r < 240 || g < 240 || b < 240) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                found = true;
            }
        }
    }
    
    if (!found) return null;
    
    return {
        left: minX,
        top: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

/**
 * Legacy diagram detection (kept for backwards compatibility)
 */
function detectDiagramRegion(imageData, width, height) {
    const data = imageData.data;
    
    // Grid-based analysis to find diagram region
    const gridSize = 20; // Divide image into grid
    const gridCols = Math.ceil(width / gridSize);
    const gridRows = Math.ceil(height / gridSize);
    
    const grid = Array(gridRows).fill(0).map(() => Array(gridCols).fill(0));
    
    // Count non-white pixels in each grid cell
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            // Check if pixel is not white (threshold: 240)
            if (r < 240 || g < 240 || b < 240) {
                const gridX = Math.floor(x / gridSize);
                const gridY = Math.floor(y / gridSize);
                if (gridY < gridRows && gridX < gridCols) {
                    grid[gridY][gridX]++;
                }
            }
        }
    }
    
    // Find the region with highest density of non-white pixels
    let maxDensity = 0;
    let bestRegion = { left: 0, top: 0, right: width, bottom: height };
    
    // Look for concentrated regions (likely diagrams)
    for (let y1 = 0; y1 < gridRows - 2; y1++) {
        for (let x1 = 0; x1 < gridCols - 2; x1++) {
            for (let y2 = y1 + 2; y2 < gridRows; y2++) {
                for (let x2 = x1 + 2; x2 < gridCols; x2++) {
                    let density = 0;
                    let cellCount = 0;
                    
                    for (let y = y1; y <= y2; y++) {
                        for (let x = x1; x <= x2; x++) {
                            density += grid[y][x];
                            cellCount++;
                        }
                    }
                    
                    const avgDensity = density / cellCount;
                    if (avgDensity > maxDensity) {
                        maxDensity = avgDensity;
                        bestRegion = {
                            left: x1 * gridSize,
                            top: y1 * gridSize,
                            right: (x2 + 1) * gridSize,
                            bottom: (y2 + 1) * gridSize
                        };
                    }
                }
            }
        }
    }
    
    // Calculate dimensions
    const diagramRegion = {
        left: bestRegion.left,
        top: bestRegion.top,
        width: bestRegion.right - bestRegion.left,
        height: bestRegion.bottom - bestRegion.top
    };
    
    // Check if we found a valid diagram (not the whole image)
    const areaRatio = (diagramRegion.width * diagramRegion.height) / (width * height);
    const hasDiagram = maxDensity > 50 && areaRatio < 0.8 && areaRatio > 0.1;
    
    console.log(`[DIAGRAM] Detection: density=${maxDensity}, areaRatio=${areaRatio}, hasDiagram=${hasDiagram}`);
    
    return { diagramRegion, hasDiagram };
}

// ========================================
// END IMAGE PROCESSING
// ========================================

// ES modules fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Initialize OpenAI client
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_ORG_ID,
    project: process.env.OPENAI_PROJECT_ID,
});

class NEETTutor {
    constructor() {
        this.model = "gpt-4o-mini";  // Switched from gpt-5-nano to avoid reasoning token issues
    }

    // Get or create session for student
    getSession(studentId) {
        const s = dbGetSession(studentId);
        return {
            previousQuestion: s.previousQuestion,
            currentTopic: s.currentTopic,
            questionCount: s.questionCount,
            history: []
        };
    }

    // Extract EVERY SINGLE WORD including stop words
    extractAllWords(text) {
        if (!text || typeof text !== 'string') return [];
        
        // Convert to lowercase
        const lowerText = text.toLowerCase();
        
        // Remove punctuation but keep important symbols
        const cleanText = lowerText
            .replace(/[.,!;:()\[\]{}"'`]/g, '')  // Remove punctuation
            .replace(/\s+/g, ' ')               // Normalize multiple spaces
            .trim();
        
        // Split into ALL words
        const words = cleanText.split(' ');
        
        // Filter out only empty strings (keep ALL words)
        return words.filter(word => word.length > 0);
    }

    // Compare questions: if they're in the SAME topic (by topic extraction), they're related
    areQuestionsRelated(question1, question2) {
        if (!question1 || !question2) return false;
        
        // Extract the topic from both questions
        const topic1 = this.extractTopic(question1);
        const topic2 = this.extractTopic(question2);
        
        // If both extract to the same meaningful topic (not "General"), they're related
        if (topic1 === topic2 && topic1 !== "General NEET Concept") {
            return true;
        }
        
        // Fallback: check keyword overlap (at least 30%)
        const words1 = this.extractAllWords(question1);
        const words2 = this.extractAllWords(question2);
        
        if (words1.length === 0 || words2.length === 0) return false;
        
        const matchingWords = words1.filter(word => words2.includes(word));
        const maxWords = Math.max(words1.length, words2.length);
        const matchPercentage = matchingWords.length / maxWords;
        
        return matchPercentage >= 0.3;
    }

    // Extract topic from question
    extractTopic(question) {
        const q = question.toLowerCase();
        
        // Biology topics
        if (q.includes('vitamin') || q.includes('deficiency') || q.includes('rickets') || q.includes('scurvy') || q.includes('beriberi') || q.includes('goiter') || q.includes('nutrition'))
            return "Human Nutrition & Vitamins";
        if (q.includes('mitosis') || q.includes('meiosis') || q.includes('cell division')) 
            return "Cell Division";
        if (q.includes('photosynthesis')) return "Photosynthesis";
        if (q.includes('dna') || q.includes('replication') || q.includes('genetic')) 
            return "DNA & Genetics";
        if (q.includes('respiration') || q.includes('breathing')) return "Respiration";
        if (q.includes('digest') || q.includes('digestion')) return "Digestive System";
        if (q.includes('circulat') || q.includes('blood') || q.includes('heart')) 
            return "Circulatory System";
        if (q.includes('excret') || q.includes('kidney')) return "Excretory System";
        if (q.includes('neuron') || q.includes('nervous')) return "Nervous System";
        if (q.includes('hormone') || q.includes('endocrine')) return "Endocrine System";
        
        // Physics topics
        if (q.includes('newton') || q.includes('law') || q.includes('motion')) 
            return "Laws of Motion";
        if (q.includes('work') || q.includes('energy') || q.includes('power')) 
            return "Work, Energy & Power";
        if (q.includes('gravitation') || q.includes('gravity')) return "Gravitation";
        if (q.includes('thermodynamic') || q.includes('heat') || q.includes('temperature')) 
            return "Thermodynamics";
        if (q.includes('optics') || q.includes('light') || q.includes('lens') || q.includes('mirror')) 
            return "Optics";
        if (q.includes('electric') || q.includes('circuit') || q.includes('current') || q.includes('ohm')) 
            return "Electricity";
        if (q.includes('magnet') || q.includes('magnetic')) return "Magnetism";
        
        // Chemistry topics
        if (q.includes('mole') || q.includes('stoichiometry')) return "Mole Concept";
        if (q.includes('atomic') || q.includes('atom') || q.includes('structure')) 
            return "Atomic Structure";
        if (q.includes('periodic') || q.includes('table') || q.includes('element')) 
            return "Periodic Table";
        if (q.includes('bond') || q.includes('chemical bond')) return "Chemical Bonding";
        if (q.includes('thermodynamic') || q.includes('thermochemistry')) 
            return "Chemical Thermodynamics";
        if (q.includes('equilibrium')) return "Chemical Equilibrium";
        if (q.includes('redox') || q.includes('oxidation')) return "Redox Reactions";
        if (q.includes('organic') || q.includes('hydrocarbon') || q.includes('compound')) 
            return "Organic Chemistry";
        
        return "General NEET Concept";
    }

    // ⭐ NEW: ANSWER VERIFICATION RESPONSE
    // When user asks "Is C) Mitochondria correct?", give direct YES/NO answer
    async answerVerificationResponse(question, previousQuestion, studentId) {
        // Get BASE QUESTION keywords to avoid mentioning them
        let baseKeywords = [];
        if (studentId) {
            const baseQuestion = getBaseQuestion(studentId);
            if (baseQuestion && baseQuestion.keywords) {
                baseKeywords = baseQuestion.keywords;
            }
        }
        const keywordsToHide = baseKeywords.join(', ');
        
        if (!previousQuestion) {
            return "I need to see your previous question to verify your answer.";
        }

        const subject = detectSubject(question);
        const subjectInstructions = this.getSubjectSpecificInstructions(subject);

        // ⭐ NEW: GUIDED LEARNING APPROACH - NO DIRECT CONFIRMATION
        // This implements the "No Direct Confirmation, Only Guidance" feature
        // The bot will NEVER say "yes that's correct" or "no that's wrong"
        // Instead, it guides students to figure out the answer themselves
        const prompt = `You are a NEET tutor using a GUIDED LEARNING approach, NOT just giving answers.

📌 SUBJECT: ${subject}
${subjectInstructions}

⭐ CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. 🚫 NEVER directly confirm "Yes, that's correct!" or "No, that's wrong"
2. 🚫 NEVER reveal whether the student's answer is right or wrong
3. 🚫 NEVER display or repeat the correct answer
4. 🚫 DO NOT mention these keywords: ${keywordsToHide}
5. ✅ INSTEAD: Provide helpful hints about the CONCEPT
6. ✅ INSTEAD: Encourage the student to THINK about the concept
7. ✅ INSTEAD: Guide them toward the right answer WITHOUT stating it

RESPONSE FORMAT (Must follow this exactly):
Start with: "I won't reveal the correct answer yet 😊" or "I won't confirm that directly, but let me help! 💡"
Then provide: Conceptual hints, definitions, related concepts
Then conclude with: "Try connecting this concept with the given options."

Example if student asked about Force:
"I won't reveal the correct answer yet 😊
But I can help you figure it out.

💡 Think about which quantity measures force in physics.
It is defined using mass and acceleration (F = ma).
Forces can change an object's motion or shape.
Try connecting this concept with the given options."

Original Question: "${previousQuestion}"
Student asking about: "${question}"

Provide ONLY GUIDANCE without confirming if they're right or wrong.
Keep the hint under 80 words. Be encouraging and educational.
DO NOT mention: ${keywordsToHide}`;

        const response = await client.chat.completions.create({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 250,
            temperature: 0.7
        });

        return response.choices[0].message.content;
    }

    // ⭐ NEW: Expanded explanation for when student asks "explain more"
    async expandedResponse(question, previousQuestion, studentId) {
        // Get BASE QUESTION keywords to avoid mentioning them
        let baseKeywords = [];
        if (studentId) {
            const baseQuestion = getBaseQuestion(studentId);
            if (baseQuestion && baseQuestion.keywords) {
                baseKeywords = baseQuestion.keywords;
            }
        }
        const keywordsToHide = baseKeywords.join(', ');
        
        const subject = detectSubject(question);
        const subjectInstructions = this.getSubjectSpecificInstructions(subject);
        
        const prompt = `You are a patient NEET tutor. The student is asking for a MORE DETAILED EXPLANATION of the previous concept.

📌 SUBJECT: ${subject}
${subjectInstructions}

EXPANSION REQUIREMENTS:
Your job is to expand the previous answer with:
1. ✅ Deeper explanation of the concept
2. ✅ Step-by-step process/mechanism
3. ✅ Real-world examples and applications
4. ✅ Related concepts and connections
5. ✅ Common misconceptions to avoid
6. ✅ Why this concept matters in NEET

⚠️ CRITICAL - STAY SAFE:
- Do NOT display or mention answer options (A, B, C, D)
- Do NOT reveal the direct answer if it's about an MCQ
- Do NOT mention chemical names/formulas if the original question used generic terms
- Do NOT mention these keywords from the base question: ${keywordsToHide}
- Keep everything conceptual and educational
- Connect to the original topic but expand thoughtfully

Previous Question/Topic: "${previousQuestion || question}"
Current Request: "${question}"

Provide a comprehensive, well-structured explanation that helps the student understand the concept deeply. Use headings, bullet points, and examples to make it clear. Keep it under 500 words.

CRITICAL: Do NOT use: ${keywordsToHide}`;

        try {
            console.log(`[API CALL] Calling OpenAI for EXPANDED EXPLANATION [Subject: ${subject}]`);
            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 1500
            });
            console.log(`[API SUCCESS] Got expanded response from OpenAI for ${subject}`);
            let result = this.extractText(response);
            
            // ⭐ POST-PROCESSING: Remove base keywords from response to prevent leakage
            if (baseKeywords.length > 0) {
                console.log(`[MASKING KEYWORDS] Removing ${baseKeywords.length} base keywords from expanded response`);
                for (const keyword of baseKeywords) {
                    // Only mask if it's not part of the question being discussed
                    if (!question.toLowerCase().includes(keyword)) {
                        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
                        result = result.replace(regex, '[concept]');
                    }
                }
            }
            
            return result;
        } catch (error) {
            console.error(`[API ERROR] OpenAI call failed:`, error.message);
            throw error;
        }
    }

    // Main tutoring method
    async tutor(studentId, currentQuestion, isEdit = false) {
        try {
            // 🔧 AUTO-CORRECT the question immediately when it enters
            const originalQuestion = currentQuestion;
            
            // ⭐ CHECK FOR CONTINUATION INTENT **BEFORE** AUTO-CORRECT (preserve original intent)
            let isContinuationBefore = detectContinuationIntent(currentQuestion);
            if (isContinuationBefore) {
                console.log(`[CONTINUATION PRE-CHECK] 🔄 Detected continuation intent BEFORE auto-correct: "${currentQuestion}"`);
            }
            
            currentQuestion = autoCorrectText(currentQuestion);
            
            // Log auto-correction attempt (ALWAYS show)
            console.log(`[AUTO-CORRECT IN TUTOR] Checking: "${originalQuestion}"`);
            if (currentQuestion !== originalQuestion) {
                console.log(`[AUTO-CORRECT IN TUTOR] ✅ CORRECTED to: "${currentQuestion}"`);
            } else {
                console.log(`[AUTO-CORRECT IN TUTOR] ✓ No typos found`);
            }
            
            const session = this.getSession(studentId);
            const previousQuestion = session.previousQuestion;
            const previousTopic = session.currentTopic;
            
            // Get ALL previous questions from history (exclude current if editing)
            const history = dbGetHistory(studentId);
            let previousQuestions = history.map(h => h.question);
            
            // ⭐ NEW: If editing, delete the last question first, then proceed normally
            if (isEdit) {
                console.log("[EDIT MODE] 🔄 Deleting previous question and replacing with edited version");
                deleteLastQuestion(studentId);
                // After deleting, still treat as fresh for classification (empty previousQuestions)
                previousQuestions = [];
            }
            
            // Use new classification function - pass ALL previous questions
            const classification = classifyMessage(currentQuestion, isEdit ? null : previousTopic, previousQuestions);
            
            console.log(`[CLASSIFICATION] Type: ${classification.type} | Topic: ${classification.topic || 'N/A'} | Message: "${currentQuestion}"`);

            // ⭐ NEW FEATURE: EXTRACT KEYWORDS AND COMPARE BEFORE STORING
            const extractedKeywords = extractMeaningfulKeywords(currentQuestion);
            console.log(`\n[DETECTED KEYWORDS] ${extractedKeywords.length} keywords: [${extractedKeywords.join(', ')}]`);
            
            // Get all PREVIOUS questions with keywords from database BEFORE saving current
            const previousQuestionsWithKeywords = getPreviousQuestionsWithKeywords(studentId);
            console.log(`[PREVIOUS QUESTIONS] Found ${previousQuestionsWithKeywords.length} previous questions`);

            // ⭐ USE PRE-CHECK FOR CONTINUATION (captured BEFORE auto-correct)
            // If user just wants "more", "explain", "tell me more" etc., continue same topic
            if (isContinuationBefore && previousQuestionsWithKeywords.length > 0) {
                console.log(`[CONTINUATION DETECTED] 🔄 User asking for more explanation: "${currentQuestion}"`);
                console.log(`[CONTINUATION MODE] ✅ Treating as FOLLOW-UP to previous topic (no keyword change)`);
            }
            
            // ⭐ CHECK FOR REPEATED QUESTIONS FIRST
            const isRepeat = isQuestionRepeated(currentQuestion, previousQuestionsWithKeywords);
            
            let matchedKeywords = [];
            let overlapPercent = 0;
            let topicDecision = 'NEW TOPIC';
            let decisionReason = 'No previous questions to compare with';
            
            // ⭐ IF CONTINUATION MODE: Skip keyword comparison, just mark as FOLLOW-UP
            if (isContinuationBefore && previousQuestionsWithKeywords.length > 0) {
                topicDecision = 'FOLLOW-UP (Continuation)';
                decisionReason = 'User requesting more explanation on same topic';
                matchedKeywords = []; // No keyword matching needed for continuation
                overlapPercent = 100; // Treat as 100% match since continuing same topic
                console.log(`[MATCHED KEYWORDS] [continuation - no keyword swap]`);
                console.log(`[KEYWORD OVERLAP] 100% (continuation mode)`);
                console.log(`[TOPIC DECISION] ${topicDecision}`);
                console.log(`[REASON] ${decisionReason}\n`);
            } else if (isRepeat) {
                // 🔄 REPEATED QUESTION - Treat as fresh start (NEW TOPIC)
                topicDecision = 'NEW TOPIC';
                decisionReason = 'Question is a repeat - treating as fresh start';
                console.log(`[MATCHED KEYWORDS] [none - repeat detected]`);
                console.log(`[KEYWORD OVERLAP] N/A (repeat detected)`);
                console.log(`[TOPIC DECISION] ${topicDecision}`);
                console.log(`[REASON] ${decisionReason}\n`);
            } else if (previousQuestionsWithKeywords.length > 0) {
                // ⭐ CHECK FOR ANSWER VERIFICATION FIRST (before keyword overlap check)
                // This ensures guided learning mode is triggered even if keywords don't match
                const isAnswerVerification = detectAnswerVerification(currentQuestion);
                if (isAnswerVerification) {
                    // Student asking if answer is correct - use guided learning regardless of keywords
                    console.log(`[ANSWER VERIFICATION EARLY CHECK] 🎓 Detected: "${currentQuestion}"`);
                    topicDecision = 'FOLLOW-UP (Answer Verification)';
                    decisionReason = 'Student asking if their answer is correct';
                    matchedKeywords = [];
                    overlapPercent = 100;
                    console.log(`[MATCHED KEYWORDS] [none - answer verification detected]`);
                    console.log(`[KEYWORD OVERLAP] 100% (answer verification mode)`);
                    console.log(`[TOPIC DECISION] ${topicDecision}`);
                    console.log(`[REASON] ${decisionReason}\n`);
                } else {
                    // ⭐ Get BASE question from session (dynamically tracked)
                    // If first question, use first in history. Otherwise use tracked base.
                    let baseQuestion = getBaseQuestion(studentId);
                    
                    // If no base question set yet, use the first question
                    if (!baseQuestion) {
                        baseQuestion = previousQuestionsWithKeywords[0];
                        console.log(`[BASE QUESTION] First question of session - setting as base`);
                    } else {
                        console.log(`[BASE QUESTION] Using dynamically tracked base question`);
                    }
                    
                    const baseKeywordsSet = new Set(baseQuestion.keywords);
                    const currentKeywordsSet = new Set(extractedKeywords);
                    
                    // Calculate matching keywords with BASE question
                    matchedKeywords = [...currentKeywordsSet].filter(k => baseKeywordsSet.has(k));
                    overlapPercent = (matchedKeywords.length / currentKeywordsSet.size) * 100;
                    
                    // Decision based on 50% threshold
                    if (overlapPercent >= 50) {
                        topicDecision = 'FOLLOW-UP (Same Topic)';
                        decisionReason = `${overlapPercent.toFixed(1)}% keyword overlap with BASE question`;
                    } else {
                        topicDecision = 'NEW TOPIC';
                        decisionReason = `${overlapPercent.toFixed(1)}% keyword overlap with BASE (below 50% threshold) - treating as new topic`;
                    }
                    
                    console.log(`\n[BASE QUESTION] "${baseQuestion.question}"`);
                    console.log(`[BASE KEYWORDS] [${baseQuestion.keywords.join(', ')}]`);
                    console.log(`[CURRENT KEYWORDS] [${extractedKeywords.join(', ')}]`);
                    console.log(`[MATCHED KEYWORDS] [${matchedKeywords.join(', ') || 'none'}]`);
                    console.log(`[KEYWORD OVERLAP] ${overlapPercent.toFixed(1)}%`);
                    console.log(`[TOPIC DECISION] ${topicDecision}`);
                    console.log(`[REASON] ${decisionReason}\n`);
                }
            } else {
                console.log(`[MATCHED KEYWORDS] none (first question)`);
                console.log(`[TOPIC DECISION] ${topicDecision}`);
                console.log(`[REASON] ${decisionReason}\n`);
            }
            
            // NOW save keywords to database AFTER comparison
            saveQuestionKeywords(studentId, currentQuestion, extractedKeywords, matchedKeywords, overlapPercent, topicDecision);
            console.log(`[KEYWORD STORAGE] ✅ Keywords saved to database`);
            displayDatabaseContents(studentId);  // ✅ DISPLAY WHAT'S IN DATABASE
            
            // ⭐ Case 3: If NEW TOPIC detected, update the base question for future comparisons
            // BUT: Don't reset base if this is an EDIT (we're replacing the last question)
            if (topicDecision === 'NEW TOPIC' && !isEdit) {
                // Get the question_id of the current question that was just saved
                const latestQuestions = getPreviousQuestionsWithKeywords(studentId);
                if (latestQuestions.length > 0) {
                    const currentQuestionRecord = latestQuestions[latestQuestions.length - 1];
                    updateBaseQuestionId(studentId, currentQuestionRecord.id);
                    console.log(`[BASE QUESTION RESET] ✅ New topic detected - "${currentQuestion}" (ID: ${currentQuestionRecord.id}) is now the base for future comparisons`);
                }
            } else if (isEdit) {
                console.log(`[BASE QUESTION] ✅ Edited question - base question NOT reset (keeping previous base)`);
            }

            // Extract words for matching analysis
            const currentWords = this.extractAllWords(currentQuestion);
            let matchedWordsCount = 0;
            let relationshipReason = "";
            
            // Check if this is a new topic
            let isNewTopic;
            let formatSelected = "";
            let formatReason = "";
            let response;
            
            // ⭐ NEW: DETECT EXPAND INTENT (e.g., "explain more", "tell me in detail")
            const hasExpandIntent = detectExpandIntent(currentQuestion);
            if (hasExpandIntent) {
                console.log(`[EXPAND MODE] 📖 Student requesting more explanation: "${currentQuestion}"`);
            }
            
            // ⭐ KEYWORD DECISION OVERRIDES CLASSIFICATION
            // If keyword analysis says NEW TOPIC, honor that even if classification says FOLLOW_UP
            let keywordBasedIsNewTopic = topicDecision === 'NEW TOPIC';
            
            // ⭐ CONTINUATION OVERRIDES CASUAL/NORMAL
            // If continuation was detected, don't treat as CASUAL/NORMAL - treat as FOLLOW_UP instead
            let effectiveClassificationType = classification.type;
            if (isContinuationBefore && (classification.type === 'CASUAL' || classification.type === 'NORMAL')) {
                console.log(`[CONTINUATION OVERRIDE] 🔄 Overriding ${classification.type} classification because continuation was detected`);
                effectiveClassificationType = 'FOLLOW_UP';
            }
            
            // ⭐ KEYWORD OVERLAP OVERRIDES ACADEMIC/CASUAL/NORMAL
            // If keyword analysis shows FOLLOW_UP with 100% overlap, override classification to FOLLOW_UP
            if (!keywordBasedIsNewTopic && topicDecision === 'FOLLOW-UP (Same Topic)' && effectiveClassificationType !== 'FOLLOW_UP') {
                console.log(`[KEYWORD OVERRIDE] 🔄 Overriding ${effectiveClassificationType} classification to FOLLOW_UP due to 100% keyword match`);
                effectiveClassificationType = 'FOLLOW_UP';
            }
            
            // Use classification-based routing
            switch (effectiveClassificationType) {
                case "CASUAL":
                    formatSelected = "CASUAL RESPONSE";
                    formatReason = "Casual greeting detected";
                    response = await this.casualGreetingResponse(currentQuestion);
                    session.questionCount = 1;
                    session.currentTopic = "General";
                    isNewTopic = true; // Casual is always new
                    break;
                    
                case "ACADEMIC":
                    formatSelected = "4-SECTION FORMAT";
                    formatReason = "Academic/NEET question detected";
                    response = await this.firstQuestionResponse(currentQuestion);
                    session.questionCount = 1;
                    session.currentTopic = classification.topic;
                    isNewTopic = true; // Academic question is new topic
                    break;
                    
                case "FOLLOW_UP":
                    // ⭐ PRIORITY 1: CONTINUATION OVERRIDE - If continuation detected, FORCE it to be follow-up
                    // (This ignores keyword overlap for "more", "tell me more", etc.)
                    if (isContinuationBefore) {
                        // ⭐ NEW: CONTINUATION MODE - User wants more explanation (no topic change)
                        formatSelected = "CONTINUATION (Deeper Explanation)";
                        formatReason = "User requesting continuation/more explanation on same topic";
                        response = await this.expandedResponse(currentQuestion, previousQuestionsWithKeywords.length > 0 ? previousQuestionsWithKeywords[previousQuestionsWithKeywords.length - 1].question : null, studentId);
                        session.questionCount += 1;
                        isNewTopic = false;
                    } else if (keywordBasedIsNewTopic) {
                        // ⭐ PRIORITY 2: CHECK KEYWORD OVERLAP - It overrides classification if no continuation
                        // Keywords say NEW TOPIC - override FOLLOW_UP classification
                        formatSelected = "4-SECTION FORMAT";
                        formatReason = "Different topic (keyword analysis)";
                        response = await this.firstQuestionResponse(currentQuestion);
                        session.questionCount = 1;
                        session.currentTopic = classification.topic;
                        isNewTopic = true;
                    } else if (hasExpandIntent) {
                        // ⭐ EXPAND MODE - Student wants more detailed explanation
                        formatSelected = "EXPANDED EXPLANATION";
                        formatReason = "Student requesting more information/detail";
                        response = await this.expandedResponse(currentQuestion, previousQuestions.length > 0 ? previousQuestions[previousQuestions.length - 1] : null, studentId);
                        session.questionCount += 1;
                        isNewTopic = false;
                    } else {
                        // Keywords confirm it's a follow-up
                        const isAnswerVerification = detectAnswerVerification(currentQuestion);
                        
                        if (isAnswerVerification) {
                            // ⭐ GUIDED LEARNING MODE - Student asking if their answer is correct
                            console.log(`[GUIDED LEARNING MODE] 🎓 Student asking: "${currentQuestion}"`);
                            console.log(`[GUIDED LEARNING APPROACH] 📚 Refusing direct confirmation, providing guidance instead`);
                            formatSelected = "GUIDED LEARNING (No Confirmation)";
                            formatReason = "Student asking if answer is correct - Using guided learning approach";
                            // Pass the previous question so the bot can provide conceptual guidance
                            response = await this.answerVerificationResponse(currentQuestion, previousQuestions.length > 0 ? previousQuestions[previousQuestions.length - 1] : null, studentId);
                            session.questionCount += 1;
                            isNewTopic = false;
                        } else if (isQuestion(currentQuestion)) {
                            // Regular follow-up academic question
                            formatSelected = "GUIDED FOLLOW-UP";
                            formatReason = "Academic follow-up question";
                            response = await this.subsequentQuestionResponse(currentQuestion, studentId);
                            session.questionCount += 1;
                            isNewTopic = false;
                        } else {
                            // Simple clarification
                            formatSelected = "DIRECT ANSWER";
                            formatReason = "Follow-up clarification";
                            response = await this.subsequentQuestionResponse(currentQuestion, studentId);
                            session.questionCount += 1;
                            isNewTopic = false;
                        }
                    }
                    break;
                    
                case "NORMAL":
                default:
                    if (!previousQuestion || isEdit) {
                        formatSelected = "CASUAL RESPONSE";
                        formatReason = "First message (normal)";
                        response = await this.casualGreetingResponse(currentQuestion);
                        session.questionCount = 1;
                        session.currentTopic = "General";
                        isNewTopic = true; // First message is new
                    } else if (isContinuationBefore && previousQuestionsWithKeywords.length > 0) {
                        // ⭐ CONTINUATION IN NORMAL CASE - User wants more explanation
                        formatSelected = "CONTINUATION (Deeper Explanation)";
                        formatReason = "User requesting continuation/more explanation on same topic";
                        response = await this.expandedResponse(currentQuestion, previousQuestionsWithKeywords[previousQuestionsWithKeywords.length - 1].question, studentId);
                        session.questionCount += 1;
                        isNewTopic = false;
                    } else {
                        formatSelected = "DIRECT ANSWER";
                        formatReason = "Follow-up (normal)";
                        response = await this.subsequentQuestionResponse(currentQuestion, studentId);
                        session.questionCount += 1;
                        isNewTopic = keywordBasedIsNewTopic; // Use keyword decision
                    }
                    break;
            }
            
            // Log the meaningful format
            console.log(`[FORMAT] ${formatSelected} | Reason: ${formatReason} | Classification: ${classification.reason}`);
            
            // ⭐ IMPORTANT: Use actual keyword-based topicDecision, not classification
            // This ensures frontend gets the correct isNewTopic flag
            isNewTopic = topicDecision === 'NEW TOPIC';
            console.log(`[FINALIZE] isNewTopic set based on topicDecision: ${isNewTopic} (${topicDecision})`);
            
            // Update session and persist to DB
            session.previousQuestion = currentQuestion;
            dbUpsertSession(studentId, {
                previousQuestion: session.previousQuestion,
                currentTopic: session.currentTopic,
                questionCount: session.questionCount
            });

            dbAddMessage(studentId, {
                question: currentQuestion,
                response,
                isNewTopic,
                questionCount: session.questionCount,
                timestamp: new Date().toISOString()
            });
            
            return {
                response: response,
                isNewTopic: isNewTopic,
                questionCount: session.questionCount,
                previousQuestion: previousQuestion,
                topic: session.currentTopic
            };
            
        } catch (error) {
            console.error("Tutoring error:", error);
            return {
                response: this.getFallbackResponse(),
                isNewTopic: true,
                questionCount: 1,
                previousQuestion: null,
                topic: "Error"
            };
        }
    }

    // Enhanced: Detect if text is a real question (for 4-block format)
    isAcademicQuestion(text) {
        if (!text || typeof text !== 'string') return false;
        const t = text.trim().toLowerCase();

        // 1️⃣ If message length < 4, treat as greeting/small talk
        if (t.length < 4) return false;

        // 2️⃣ If contains "?", likely a question
        if (t.includes('?')) return true;

        // 3️⃣ If starts with question word or contains question keyword
        const questionWords = [
            'what', 'why', 'when', 'where', 'how', 'which', 'who', 'whom', 'whose', 'explain', 'define', 'tell', 'describe', 'find', 'choose', 'select', 'pick', 'identify', 'true', 'false', 'correct', 'incorrect'
        ];
        const startsWithQWord = questionWords.some(qw => t.startsWith(qw + ' '));
        const containsQWord = questionWords.some(qw => t.includes(qw));
        if (startsWithQWord || containsQWord) return true;

        // MCQ heuristics: option markers (A/B/C/D or (a)(b)...)
        const optionMarkersRegex = /(\b[abcd]\s*[\)\.:;]|\([abcd]\)|\b[1234]\s*[\)\.:;]|\([1234]\))/g;
        const optionsCount = (t.match(optionMarkersRegex) || []).length;
        if (optionsCount >= 2 || /\boptions?\b/.test(t)) return true;

        // If none of the above, treat as greeting/small talk
        return false;
    }

    // Casual/greeting response without 4-section format
    async casualGreetingResponse(text) {
        const prompt = `You are a friendly NEET tutor. The user sent a greeting or casual message. Respond briefly and warmly in 1-2 sentences. Do NOT use any structured format or emojis. Keep it conversational.

User: "${text}"`;

        const response = await client.chat.completions.create({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 600
        });

        return this.cleanStructuredFormat(this.extractText(response));
    }

    // EXACT 4-section format for FIRST question
    async firstQuestionResponse(question) {
        const topic = this.extractTopic(question);
        const subject = detectSubject(question); // NEW: Detect the subject
        const lessonInfo = getLessonInfo(topic, subject); // NEW: Get NCERT lesson info
        
        // Ensure concepts are subject-specific
        const subjectInstructions = this.getSubjectSpecificInstructions(subject);
        
        const prompt = `You are a patient NEET tutor. The student is asking the FIRST question about a NEW topic.

📌 SUBJECT & CURRICULUM IDENTIFICATION:
Subject: ${subject}
${subjectInstructions}

IMPORTANT RULES:
1. Use this EXACT 4-section format with emojis:

📚 Concept:
📘 Lesson Name: ${lessonInfo.lesson}
(From NCERT: ${lessonInfo.ncert})
🧬 Specific Topic: ${lessonInfo.specificTopic}

🌟 Core Concept:
[1 simple sentence explaining what the question is ASKING about (topic/concept area). Do NOT reveal the answer. Do NOT mention:
- Chemical names or formulas
- Properties, effects, or characteristics
- Composition or what something is made of
- Any answer options (A, B, C, D)
Simply state what concept/topic this question covers. Example: "This asks about the role of a specific biological structure"]

✨ Helpful Hint:
[A guiding hint that makes students THINK. Ask them to consider related concepts or functions. Example: "Think about which part of the cell is responsible for producing energy needed for activities like movement, growth, and repair". Maximum 25 words. Guide thinking but do NOT mention any options or directly reveal the answer.]

💬 Final Point:
[Ask: "What's going through your mind right now? What's your understanding at this moment? Tell me your view on it."]

2. ⚠️ CRITICAL - NEVER EVER:
   - Do NOT display, mention, or reference answer options (A, B, C, D)
   - Do NOT reveal which option is correct
   - Do NOT give the direct answer to the question
   - Do NOT write out what the answer choices are
   - Do NOT confirm or deny any option as correct
   - Do NOT mention chemical names, formulas, or compositions
   - Do NOT describe properties, effects, or characteristics of substances
   - Do NOT give away the answer even indirectly

3. CONTENT RULES:
   - Keep everything conceptual and educational
   - Use only guiding hints and questions
   - Never directly answer the MCQ
   - Never suggest which option to pick
   - For Core Concept: ONLY state what topic/concept area this question covers - do NOT describe it
   - Keep explanations within ${subject} only - NEVER mix subjects

4. Format Rules:
   - Keep everything short and clear
   - Use very simple English
   - 4 sections ONLY - nothing else

Student Question: "${question}"

Respond with ONLY the 4 sections above, no additional text. DO NOT DISPLAY OR MENTION THE OPTIONS UNDER ANY CIRCUMSTANCES.`;

        try {
            console.log(`[API CALL] Calling OpenAI with model: ${this.model} [Subject: ${subject}] [Lesson: ${lessonInfo.lesson}]`);
            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 2000  // Increased for reasoning + 6-section format
            });
            console.log(`[API SUCCESS] Got response from OpenAI for ${subject}`);
            return this.extractText(response);
        } catch (error) {
            console.error(`[API ERROR] OpenAI call failed:`, error.message);
            throw error;
        }
    }

    // Get subject-specific instructions
    getSubjectSpecificInstructions(subject) {
        const instructions = {
            "Physics": "Only use Physics concepts (mechanics, thermodynamics, electricity, optics, waves, etc.). Do NOT include Biology or Chemistry concepts.",
            "Chemistry": "Only use Chemistry concepts (atoms, molecules, reactions, bonding, equilibrium, organic chemistry, etc.). Do NOT include Physics or Biology concepts.",
            "Biology": "Only use Biology concepts (cells, genetics, ecology, evolution, physiology, botany, etc.). Do NOT include Physics or Chemistry concepts.",
            "General NEET": "Use appropriate NEET concepts from any relevant subject."
        };
        return instructions[subject] || instructions["General NEET"];
    }

    // Smart follow-up response with state-based logic
    async subsequentQuestionResponse(question, studentId) {
        // Get BASE QUESTION keywords to avoid mentioning them
        let baseKeywords = [];
        if (studentId) {
            const baseQuestion = getBaseQuestion(studentId);
            if (baseQuestion && baseQuestion.keywords) {
                baseKeywords = baseQuestion.keywords;
            }
        }
        const keywordsToHide = baseKeywords.join(', ');
        
        // Check if this is a concept question
        const isConcept = isConceptQuestion(question);
        const subject = detectSubject(question); // NEW: Detect the subject
        
        // Check if user proposed an answer
        const answerProposal = detectAnswerProposal(question);
        
        // Check if user requested confirmation
        const confirmationRequested = detectConfirmationRequest(question);

        // ⭐ STATE 0: IMPLICIT ANSWER PROPOSAL - Student asking "what is thermometer" → Answer safely with masked words
        if (answerProposal.hasProposal && isConcept) {
            // Extract answer option words to mask them
            const answerWords = extractAnswerOptionsFromQuestion(question);
            
            const relatedKeywordsList = answerWords.map(word => getRelatedKeywordsToMask(word)).flat().join(', ');
            
            const prompt = `You are a NEET tutor. The student is asking about a specific option/concept, which is an implicit answer proposal.

⚠️ CRITICAL SAFETY RULES - DO NOT REVEAL THE ANSWER:
1. DO NOT mention the specific item name directly
2. DO NOT use related keywords that hint at the answer
3. DO NOT mention related concepts like: ${relatedKeywordsList}
4. DO NOT mention these keywords from the base question: ${keywordsToHide}
5. Instead, describe GENERIC properties and uses that could apply to MULTIPLE devices/substances

APPROACH:
✅ Describe general scientific principles (e.g., "devices work by detecting changes in physical properties")
✅ Discuss measurement concepts generically ("units used to express measurements")
✅ Talk about different types of instruments without specifying which one
✅ Describe applications without naming the item
❌ DO NOT say "temperature", "thermal", "pressure", "voltage", "current", etc. - these reveal the answer!
❌ DO NOT say "mercury", "glass tube", "expansion" - these are specific hints!
❌ DO NOT mention: ${keywordsToHide}

GENERIC APPROACH:
Instead of: "A thermometer measures temperature using thermal expansion"
Try: "[Answer option] is an instrument used to quantify a specific physical property. Different designs exist to measure this property in various contexts."

Instead of: "An ammeter measures current"
Try: "[Answer option] is a device designed to quantify a specific electrical property. It operates on electromagnetic principles."

Student's question: "${question}"

Provide a GENERIC answer that describes principles without revealing the specific item, measurement type, or related keywords:`;

            const rawResponse = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 600
            });

            let response = this.extractText(rawResponse);
            
            // Mask any answer words that weren't already masked by AI
            if (answerWords.length > 0) {
                response = maskAnswerWordsInResponse(response, answerWords);
            }
            
            return response;
        }

        // STATE 1: Concept question → Guide thinking WITHOUT revealing the ANSWER
        if (isConcept) {
            const subjectInstructions = this.getSubjectSpecificInstructions(subject);
            
            const prompt = `You are a NEET tutor. The student is asking a concept question on the SAME TOPIC (follow-up).

📌 SUBJECT: ${subject}
${subjectInstructions}

⚠️ CRITICAL RULES - DO NOT REVEAL THE ANSWER:
1. Do NOT mention the chemical name, formula, or substance identity (e.g., don't say "nitrous oxide" or "N₂O")
2. Do NOT display, mention, or reference answer options (A, B, C, D)
3. Do NOT reveal which option is correct
4. Do NOT mention these keywords from the base question: ${keywordsToHide}
5. Instead: Explain HOW it works, its properties, effects, mechanism, and uses - WITHOUT naming what it is

FOLLOW-UP EXPLANATION FORMAT:
✅ DO explain:
   - How it works (mechanism of action)
   - What effects it has
   - Where/how it's used (medical applications)
   - Its properties and characteristics
   - Neurotransmitter interactions, etc.

❌ DO NOT reveal:
   - The chemical name or formula
   - What substance/element it is (the answer to the MCQ)
   - Which option (A, B, C, D) is correct
   - Keywords from previous questions: ${keywordsToHide}

EXAMPLE:
❌ WRONG: "Laughing gas is nitrous oxide (N₂O), a colorless gas..."
✅ RIGHT: "This is a colorless, non-flammable gas with a slightly sweet aroma. In medicine, it's used as an anesthetic and analgesic, providing pain relief and sedation. When inhaled, it can produce feelings of euphoria and relaxation. Its mechanism of action involves affecting neurotransmitter activity in the brain, which can lead to changes in mood and perception. It's important to use it under medical supervision due to potential side effects."

Student Question: "${question}"

Explain the concept thoroughly WITHOUT revealing the chemical identity:`;

            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 800
            });

            return this.extractText(response);
        }
        
        // STATE 2: Answer proposed + Confirmation requested → Give YES/NO + explanation
        if (answerProposal.hasProposal && confirmationRequested) {
            const prompt = `You are a NEET tutor. The student proposed an answer and is asking for confirmation.

⚠️ CRITICAL: You must determine if the answer is CORRECT or INCORRECT, then respond accordingly:
- If CORRECT: Say "YES, that's correct!" + brief explanation (2 sentences max)
- If INCORRECT: Say "Not quite. Let me guide you to think about..." + ask them to reconsider without directly giving the answer

IMPORTANT RULES:
1. Start with YES or NO clearly
2. Give a brief explanation (2-3 sentences max)
3. Be encouraging
4. Keep it under 80 words
5. Guide them to think deeper if wrong - don't just say "no"
6. DO NOT mention these keywords from the base question: ${keywordsToHide}

Student's proposed answer: ${answerProposal.proposedAnswer}
Student's question: "${question}"

Respond with YES or NO followed by guidance:`;

            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 600
            });

            return this.extractText(response);
        }
        
        // STATE 3: Answer proposed but NO confirmation → Encourage self-checking
        if (answerProposal.hasProposal && !confirmationRequested) {
            const prompt = `You are a NEET tutor. The student proposed an answer but didn't ask for confirmation.

CRITICAL RULES:
1. DO NOT say if their answer is correct or wrong
2. DO NOT reveal the correct option
3. DO NOT mention these keywords from the base question: ${keywordsToHide}
4. Encourage them to self-check their reasoning

GUIDANCE APPROACH:
1. Ask reflective questions like:
   - "What made you choose this option?"
   - "Can you explain your reasoning?"
   - "What's your thought process here?"
2. Help them verify their own thinking
3. Keep it under 60 words

Student's proposed answer: ${answerProposal.proposedAnswer}
Student's question: "${question}"

Encourage self-reflection without confirming/denying their answer:`;

            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{ role: "user", content: prompt }],
                max_completion_tokens: 500
            });

            return this.extractText(response);
        }
        
        // STATE 4: No answer proposed → Give hints + thinking questions
        const prompt = `You are a NEET tutor. The student is asking a follow-up question about an MCQ but hasn't proposed an answer yet.

CRITICAL RULES:
1. NEVER give the correct answer directly
2. NEVER reveal which option is correct
3. DO NOT mention these keywords from the base question: ${keywordsToHide}
4. Give hints to help them think
5. Use elimination logic
6. Ask guiding questions like:
   - "What's going through your mind right now?"
   - "Which options can you eliminate and why?"
   - "What do you think based on the hint?"
6. Keep it under 100 words

Student Question: "${question}"

Give hints and ask thinking questions WITHOUT revealing the answer:`;

        const response = await client.chat.completions.create({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 800
        });

        let answer = this.extractText(response);
        
        // Clean any accidental structured format
        answer = this.cleanStructuredFormat(answer);
        
        return answer;
    }

    // Clean any accidental structured format
    cleanStructuredFormat(text) {
        return text
            .replace(/📚 Concept:.*\n?/g, '')
            .replace(/🌟 Core Concept:.*\n?/g, '')
            .replace(/✨ Helpful Hint:.*\n?/g, '')
            .replace(/💬 Final Point:.*\n?/g, '')
            .replace(/\*\*.*\*\*/g, '')  // Remove bold text
            .replace(/#\s+/g, '')       // Remove headings
            .replace(/- /g, '')         // Remove bullet points
            .replace(/\n{2,}/g, '\n')   // Remove multiple newlines
            .trim();
    }

    extractText(response) {
        console.log('[EXTRACT] Response type:', typeof response);
        console.log('[EXTRACT] Response keys:', Object.keys(response || {}));
        
        // For chat.completions API responses
        if (response.choices && response.choices[0] && response.choices[0].message) {
            const content = response.choices[0].message.content;
            console.log('[EXTRACT] Found content in choices[0].message.content:', content?.substring(0, 100));
            return content || "Let me help you understand this...";
        }
        
        // For Messages API responses
        if (response.content && response.content[0]) {
            const text = response.content[0].text;
            console.log('[EXTRACT] Found text in content[0].text:', text?.substring(0, 100));
            return text || "Let me help you understand this...";
        }
        
        // Fallback for older response format
        if (response.output_text) {
            console.log('[EXTRACT] Found output_text');
            return response.output_text;
        }
        
        if (response.output && response.output[0]) {
            const output = response.output[0];
            if (output.content && output.content[0]) {
                console.log('[EXTRACT] Found output[0].content[0].text');
                return output.content[0].text || "Let me help you understand this...";
            }
        }
        
        console.log('[EXTRACT] No valid content found, using fallback');
        return "I'll help you with that...";
    }

    // Analyze image using OpenAI vision
    async analyzeImage(imageBase64, question = "") {
        try {
            const prompt = question 
                ? `A student is asking about this image with the question: "${question}"\n\nAnalyze the image and provide a helpful explanation.`
                : "Analyze this image and describe what you see. If it contains a scientific diagram, problem, or educational content, provide an explanation.";

            const response = await client.chat.completions.create({
                model: this.model,
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: { url: imageBase64 }
                        }
                    ]
                }],
                max_completion_tokens: 300
            });

            return this.extractText(response);
        } catch (error) {
            console.error("Image analysis error:", error);
            return "I couldn't analyze the image. Please try again or describe what you see in the image.";
        }
    }

    getFallbackResponse() {
        return `📚 Concept: Learning Process

🌟 Core Concept:
Learning happens step by step through questions and practice.

✨ Helpful Hint:
Break big problems into smaller pieces.

💬 Final Point:
What's going through your mind right now? What's your understanding at this moment? Tell me your view on it.`;
    }

    // Get session history
    getSessionHistory(studentId) {
        const history = dbGetHistory(studentId);
        // Ensure all fields are safe
        return history.map(item => ({
            question: item.question || '',
            response: item.response || '',
            isNewTopic: item.isNewTopic || false,
            questionCount: item.questionCount || 0,
            timestamp: item.timestamp || new Date().toISOString()
        }));
    }

    // Clear session
    clearSession(studentId) {
        dbClearSession(studentId);
    }
}

// Initialize tutor
const tutor = new NEETTutor();

// API Routes
app.post("/api/tutor/ask", async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { studentId, question, image, isEdit } = req.body;
        
        if (!studentId || (!question && !image)) {
            const errorResponse = { 
                success: false, 
                error: "studentId and either question or image are required" 
            };
            logAPIRequest('/api/tutor/ask', req.body, errorResponse, Date.now() - startTime);
            return res.status(400).json(errorResponse);
        }

        // Log if image is received
        if (image) {
            console.log("\n[IMAGE RECEIVED]", {
                studentId,
                question: question || "[no text]",
                imageSize: image.length,
                imageType: image.substring(0, 30) + "...",
                isEdit: isEdit || false
            });
        }

        // If image is provided, analyze it first
        if (image) {
            try {
                // Step 1: Extract text using OCR
                console.log("\n[IMAGE PROCESSING] Step 1: Extracting text with OCR...");
                const extractedText = await extractTextFromImage(image);
                console.log("[OCR EXTRACTED TEXT]", extractedText);
                
                // Step 2: Extract diagram/illustration only
                console.log("[IMAGE PROCESSING] Step 2: Extracting diagram...");
                const diagramImage = await extractDiagramFromImage(image);
                console.log("[DIAGRAM EXTRACTED] Length:", diagramImage.length);
                
                // Use extracted text as the question (ignore user's typed message like "explain the image please")
                let questionToProcess = extractedText || question || "Please analyze this image";
                
                // AUTO-CORRECT extracted text
                questionToProcess = autoCorrectText(questionToProcess);
                console.log("[OCR AUTO-CORRECTED]", questionToProcess);
                
                // Use vision API to understand the diagram
                const imageAnalysis = await tutor.analyzeImage(diagramImage, questionToProcess);
                const combinedQuestion = `${questionToProcess}\n\n[Image Analysis]: ${imageAnalysis}`;

                const wordsForLog = tutor.extractAllWords(combinedQuestion);
                console.log("\n[ASK-IMAGE]", { studentId, extractedQuestion: questionToProcess, hasImage: true, isEdit: isEdit || false });
                console.log("[WORDS]", `count=${wordsForLog.length}`, wordsForLog.slice(0, 10));

                const result = await tutor.tutor(studentId, combinedQuestion, isEdit);

                console.log("[TUTOR]", {
                    isNewTopic: result.isNewTopic,
                    questionCount: result.questionCount,
                    topic: result.topic
                });
                
                // Return with extracted question and diagram
                const successResponse = { 
                    success: true, 
                    response: result.response,
                    isNewTopic: result.isNewTopic,
                    questionCount: result.questionCount,
                    previousQuestion: result.previousQuestion,
                    topic: result.topic,
                    extractedQuestion: extractedText, // OCR extracted question
                    diagramImage: diagramImage, // Extracted diagram only
                    timestamp: new Date().toISOString()
                };
                
                logAPIRequest('/api/tutor/ask', { question: extractedText, image: true }, successResponse, Date.now() - startTime);
                res.json(successResponse);
            } catch (imageError) {
                console.error("Image analysis failed:", imageError);
                const errorResponse = { 
                    success: false, 
                    error: "Failed to analyze image" 
                };
                logAPIRequest('/api/tutor/ask', req.body, errorResponse, Date.now() - startTime);
                res.status(500).json(errorResponse);
            }
        } else {
            // Regular text question - AUTO-CORRECT typos first
            let correctedQuestion = question ? autoCorrectText(question) : question;
            
            // Log auto-correction attempt (always show, whether corrected or not)
            console.log(`[AUTO-CORRECT ATTEMPT] Original: "${question}"`);
            if (correctedQuestion !== question) {
                console.log(`[AUTO-CORRECT APPLIED] Corrected to: "${correctedQuestion}"`);
            } else {
                console.log(`[AUTO-CORRECT CHECK] No typos found - text is correct`);
            }
            
            const wordsForLog = tutor.extractAllWords(correctedQuestion);
            console.log("\n[ASK]", { studentId, question: correctedQuestion, isEdit: isEdit || false });
            console.log("[WORDS]", `count=${wordsForLog.length}`, wordsForLog);

            const result = await tutor.tutor(studentId, correctedQuestion, isEdit);

            console.log("[TUTOR]", {
                isNewTopic: result.isNewTopic,
                questionCount: result.questionCount,
                topic: result.topic
            });
            
            console.log("[RESPONSE]", {
                responseLength: result.response?.length || 0,
                responsePreview: result.response?.substring(0, 100) || 'NO RESPONSE'
            });
            
            const successResponse = { 
                success: true, 
                response: result.response,
                isNewTopic: result.isNewTopic,
                questionCount: result.questionCount,
                previousQuestion: result.previousQuestion,
                topic: result.topic,
                timestamp: new Date().toISOString()
            };
            
            logAPIRequest('/api/tutor/ask', req.body, successResponse, Date.now() - startTime);
            res.json(successResponse);
        }
        
    } catch (error) {
        console.error("Server error:", error);
        const errorResponse = { 
            success: false, 
            error: "Internal server error" 
        };
        logAPIRequest('/api/tutor/ask', req.body, errorResponse, Date.now() - startTime);
        res.status(500).json(errorResponse);
    }
});

app.get("/api/tutor/history/:studentId", (req, res) => {
    const { studentId } = req.params;
    const history = tutor.getSessionHistory(studentId);
    res.json({ success: true, history });
});

app.post("/api/tutor/clear", (req, res) => {
    const { studentId } = req.body;
    if (!studentId) {
        return res.status(400).json({ 
            success: false, 
            error: "studentId is required" 
        });
    }
    
    tutor.clearSession(studentId);
    res.json({ success: true, message: "Session cleared" });
});

app.get("/api/tutor/session/:studentId", (req, res) => {
    const { studentId } = req.params;
    const session = tutor.getSession(studentId);
    res.json({ 
        success: true, 
        session: {
            previousQuestion: session.previousQuestion,
            currentTopic: session.currentTopic,
            questionCount: session.questionCount,
            historyLength: dbGetHistory(studentId).length
        }
    });
});

// Simplified API endpoint: question + optional image URL
app.post("/api/answer", async (req, res) => {
    const startTime = Date.now();
    
    try {
        let { question, image } = req.body;
        
        if (!question) {
            const errorResponse = { success: false, error: "question is required" };
            logAPIRequest('/api/answer', req.body, errorResponse, Date.now() - startTime);
            return res.status(400).json(errorResponse);
        }

        // 🔧 AUTO-CORRECT the question
        const originalQuestion = question;
        question = autoCorrectText(question);
        if (question !== originalQuestion) {
            console.log(`[AUTO-CORRECT /api/answer] Original: "${originalQuestion}"`);
            console.log(`[AUTO-CORRECT /api/answer] Corrected: "${question}"`);
        }

        // Generate a temporary student ID for this request
        const tempStudentId = `temp_${Date.now()}`;
        
        // If image URL is provided, fetch and process it
        let combinedQuestion = question;
        if (image && image !== "null" && image !== null) {
            try {
                console.log("[API] Processing image URL:", image);
                
                // Fetch image from URL
                const response = await fetch(image);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const base64Image = `data:${response.headers.get('content-type') || 'image/jpeg'};base64,${buffer.toString('base64')}`;
                
                // Extract text from image
                const extractedText = await extractTextFromImage(base64Image);
                console.log("[API] Extracted text:", extractedText);
                
                // Extract diagram
                const diagramImage = await extractDiagramFromImage(base64Image);
                
                // Analyze image
                const imageAnalysis = await tutor.analyzeImage(diagramImage, question);
                combinedQuestion = `${question}\n\n[Extracted Text]: ${extractedText}\n[Image Analysis]: ${imageAnalysis}`;
                
            } catch (imageError) {
                console.error("[API] Image processing error:", imageError);
                // Continue with text-only question if image fails
            }
        }

        // Get AI response
        const result = await tutor.tutor(tempStudentId, combinedQuestion, false);
        
        const successResponse = { 
            success: true, 
            response: result.response
        };
        
        logAPIRequest('/api/answer', req.body, successResponse, Date.now() - startTime);
        
        res.json(successResponse);
        
    } catch (error) {
        console.error("[API] Error:", error);
        const errorResponse = { 
            success: false, 
            error: "Internal server error" 
        };
        logAPIRequest('/api/answer', req.body, errorResponse, Date.now() - startTime);
        res.status(500).json(errorResponse);
    }
});

// GET endpoint for API documentation
app.get("/api/answer", (req, res) => {
    res.json({
        endpoint: "POST /api/answer",
        description: "Simple Q&A API - Send a question with optional image URL and get AI response",
        method: "POST",
        contentType: "application/json",
        request: {
            question: "string (required) - Your question with answer options",
            image: "string or null (optional) - Image URL or null"
        },
        response: {
            success: "boolean",
            response: "string - AI generated response"
        },
        example: {
            request: {
                question: "What is photosynthesis?",
                image: null
            },
            response: {
                success: true,
                response: "📚 Concept: Photosynthesis..."
            }
        },
        usage: {
            curl: "curl -X POST http://localhost:3000/api/answer -H 'Content-Type: application/json' -d '{\"question\":\"What is acceleration?\",\"image\":null}'",
            javascript: "fetch('http://localhost:3000/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What is acceleration?', image: null }) })"
        },
        monitoring: {
            logs: "GET /api/logs - View all recent API requests and responses (JSON)",
            logsUI: "GET /logs - View logs in a nice UI"
        }
    });
});

// API Logs endpoint - JSON format
app.get("/api/logs", (req, res) => {
    res.json({
        success: true,
        totalLogs: apiLogs.length,
        logs: apiLogs
    });
});

// API Logs endpoint - HTML UI
app.get("/logs", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API Request Logs - NEET Tutor</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 20px;
                min-height: 100vh;
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
                background: white;
                border-radius: 12px;
                padding: 30px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.2);
            }
            h1 {
                color: #667eea;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .subtitle {
                color: #666;
                margin-bottom: 20px;
                font-size: 0.95rem;
            }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin-bottom: 20px;
            }
            .stat {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 20px;
                border-radius: 8px;
                color: white;
                text-align: center;
            }
            .stat-value {
                font-size: 2.5rem;
                font-weight: bold;
                margin-bottom: 5px;
            }
            .stat-label {
                font-size: 0.9rem;
                opacity: 0.9;
            }
            .controls {
                display: flex;
                gap: 10px;
                margin-bottom: 20px;
                flex-wrap: wrap;
            }
            button {
                padding: 10px 20px;
                background: #667eea;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.2s;
            }
            button:hover {
                background: #5568d3;
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
            }
            button:active {
                transform: translateY(0);
            }
            .log-entry {
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                padding: 20px;
                margin-bottom: 15px;
                background: white;
                transition: all 0.2s;
            }
            .log-entry:hover {
                border-color: #667eea;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
            }
            .log-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
                padding-bottom: 10px;
                border-bottom: 1px solid #e0e0e0;
                flex-wrap: wrap;
                gap: 10px;
            }
            .log-id {
                font-weight: bold;
                color: #667eea;
                font-size: 1.1rem;
            }
            .timestamp {
                color: #666;
                font-size: 0.85rem;
            }
            .status {
                padding: 6px 14px;
                border-radius: 20px;
                font-size: 0.85rem;
                font-weight: bold;
            }
            .status.success {
                background: #d4edda;
                color: #155724;
            }
            .status.error {
                background: #f8d7da;
                color: #721c24;
            }
            .duration {
                color: #666;
                font-size: 0.85rem;
                margin-left: 10px;
                padding: 4px 10px;
                background: #f0f0f0;
                border-radius: 12px;
            }
            .log-content {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 20px;
            }
            @media (max-width: 768px) {
                .log-content {
                    grid-template-columns: 1fr;
                }
            }
            .section {
                background: #f8f9fa;
                padding: 15px;
                border-radius: 6px;
            }
            .section-title {
                font-weight: bold;
                color: #667eea;
                margin-bottom: 12px;
                font-size: 0.9rem;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .field {
                margin-bottom: 10px;
                font-size: 0.9rem;
                line-height: 1.5;
            }
            .field-label {
                color: #666;
                font-weight: 600;
            }
            .field-value {
                color: #333;
                margin-left: 8px;
                word-break: break-word;
            }
            .response-text {
                background: white;
                padding: 12px;
                border-radius: 6px;
                margin-top: 10px;
                white-space: pre-wrap;
                word-wrap: break-word;
                max-height: 200px;
                overflow-y: auto;
                font-size: 0.85rem;
                line-height: 1.6;
                border: 1px solid #e0e0e0;
            }
            .expand-btn {
                background: transparent;
                color: #667eea;
                padding: 6px 12px;
                font-size: 0.85rem;
                margin-top: 10px;
                border: 1px solid #667eea;
            }
            .expand-btn:hover {
                background: #667eea;
                color: white;
            }
            .no-logs {
                text-align: center;
                padding: 80px 20px;
                color: #666;
            }
            .no-logs-icon {
                font-size: 5rem;
                margin-bottom: 20px;
            }
            .no-logs h3 {
                color: #333;
                margin-bottom: 10px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>
                <span>📊</span>
                API Request Logs
            </h1>
            <div class="subtitle">Monitor all API requests and responses in real-time</div>
            
            <div class="stats">
                <div class="stat">
                    <div class="stat-value" id="totalLogs">0</div>
                    <div class="stat-label">Total Requests</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="successCount">0</div>
                    <div class="stat-label">Successful</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="errorCount">0</div>
                    <div class="stat-label">Errors</div>
                </div>
            </div>
            
            <div class="controls">
                <button onclick="refreshLogs()">🔄 Refresh</button>
                <button onclick="clearLogs()">🗑️ Clear Logs</button>
                <button onclick="exportLogs()">💾 Export JSON</button>
                <button onclick="window.location.href='/'">🏠 Back to Chat</button>
            </div>
            
            <div id="logsContainer"></div>
        </div>
        
        <script>
            let logs = [];
            
            async function refreshLogs() {
                try {
                    const response = await fetch('/api/logs');
                    const data = await response.json();
                    logs = data.logs;
                    renderLogs();
                } catch (error) {
                    console.error('Failed to fetch logs:', error);
                }
            }
            
            async function clearLogs() {
                if (confirm('Are you sure you want to clear all logs?')) {
                    try {
                        await fetch('/api/logs/clear', { method: 'POST' });
                        refreshLogs();
                    } catch (error) {
                        alert('Failed to clear logs: ' + error.message);
                    }
                }
            }
            
            function exportLogs() {
                const dataStr = JSON.stringify(logs, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`api-logs-\${new Date().toISOString()}.json\`;
                a.click();
            }
            
            function toggleResponse(id) {
                const elem = document.getElementById(\`response-\${id}\`);
                const btn = document.getElementById(\`btn-\${id}\`);
                if (elem.style.maxHeight === 'none') {
                    elem.style.maxHeight = '200px';
                    btn.textContent = 'Show Full Response';
                } else {
                    elem.style.maxHeight = 'none';
                    btn.textContent = 'Show Less';
                }
            }
            
            function renderLogs() {
                const container = document.getElementById('logsContainer');
                
                if (logs.length === 0) {
                    container.innerHTML = \`
                        <div class="no-logs">
                            <div class="no-logs-icon">📭</div>
                            <h3>No API requests yet</h3>
                            <p>Make a POST request to /api/answer to see logs here</p>
                            <p style="margin-top: 10px;"><a href="/" style="color: #667eea;">Go to chat interface</a></p>
                        </div>
                    \`;
                    document.getElementById('totalLogs').textContent = '0';
                    document.getElementById('successCount').textContent = '0';
                    document.getElementById('errorCount').textContent = '0';
                    return;
                }
                
                const successCount = logs.filter(l => l.response.success).length;
                const errorCount = logs.length - successCount;
                
                document.getElementById('totalLogs').textContent = logs.length;
                document.getElementById('successCount').textContent = successCount;
                document.getElementById('errorCount').textContent = errorCount;
                
                container.innerHTML = logs.map(log => \`
                    <div class="log-entry">
                        <div class="log-header">
                            <div>
                                <span class="log-id">#\${log.id}</span>
                                <span class="timestamp">\${new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="status \${log.response.success ? 'success' : 'error'}">
                                    \${log.response.success ? '✅ Success' : '❌ Error'}
                                </span>
                                <span class="duration">\${log.duration}</span>
                            </div>
                        </div>
                        
                        <div class="log-content">
                            <div class="section">
                                <div class="section-title">📥 Request</div>
                                <div class="field">
                                    <span class="field-label">Endpoint:</span>
                                    <span class="field-value">\${log.endpoint}</span>
                                </div>
                                <div class="field">
                                    <span class="field-label">Question:</span>
                                    <span class="field-value">\${log.request.question || 'N/A'}</span>
                                </div>
                                <div class="field">
                                    <span class="field-label">Has Image:</span>
                                    <span class="field-value">\${log.request.hasImage ? '✅ Yes' : '❌ No'}</span>
                                </div>
                            </div>
                            
                            <div class="section">
                                <div class="section-title">📤 Response</div>
                                \${log.response.success ? \`
                                    <div class="response-text" id="response-\${log.id}">\${log.response.fullResponse}</div>
                                    <button class="expand-btn" id="btn-\${log.id}" onclick="toggleResponse(\${log.id})">Show Full Response</button>
                                \` : \`
                                    <div class="field">
                                        <span class="field-label">Error:</span>
                                        <span class="field-value" style="color: #dc3545;">\${log.response.error}</span>
                                    </div>
                                \`}
                            </div>
                        </div>
                    </div>
                \`).join('');
            }
            
            // Auto-refresh every 5 seconds
            setInterval(refreshLogs, 5000);
            
            // Initial load
            refreshLogs();
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// Clear logs endpoint
app.post("/api/logs/clear", (req, res) => {
    clearAPILogs();
    res.json({ success: true, message: "Logs cleared" });
});

// Debug endpoint to extract words
app.post("/api/tutor/debug/words", (req, res) => {
    try {
        const { question } = req.body;
        
        if (!question) {
            return res.status(400).json({ 
                success: false, 
                error: "Question is required" 
            });
        }

        const words = tutor.extractAllWords(question);
        const topic = tutor.extractTopic(question);
        
        res.json({ 
            success: true, 
            question: question,
            extractedWords: words,
            wordCount: words.length,
            detectedTopic: topic
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ✅ NEW: API endpoint to view database contents
app.get("/api/database/contents", (req, res) => {
    try {
        const studentId = req.query.studentId || null;
        
        if (!db) {
            return res.json({ 
                success: false, 
                error: "Database not initialized" 
            });
        }
        
        const query = studentId 
            ? 'SELECT * FROM question_keywords WHERE student_id = ? ORDER BY id DESC'
            : 'SELECT * FROM question_keywords ORDER BY id DESC';
        
        const result = db.exec(query, studentId ? [studentId] : []);
        
        if (result.length === 0 || result[0].values.length === 0) {
            return res.json({ 
                success: true,
                message: "Database is empty",
                data: []
            });
        }
        
        const data = result[0].values.map(row => ({
            id: row[0],
            studentId: row[1],
            questionId: row[2],
            question: row[3],
            keywords: row[4].split('|').filter(k => k.trim()),
            matchedKeywords: row[5] ? row[5].split('|').filter(k => k.trim()) : [],
            keywordOverlapPercent: row[6],
            topicDecision: row[7],
            timestamp: row[8]
        }));
        
        res.json({ 
            success: true,
            count: data.length,
            studentId: studentId || "All",
            data: data
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Serve frontend
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 NEET Tutor Chatbot running on http://localhost:${PORT}`);
    console.log("\n📚 Teaching Method:");
    console.log("✅ FIRST question of NEW topic → 4-section format");
    console.log("✅ SUBSEQUENT questions → Short direct answers only");
    console.log("\n📊 Available endpoints:");
    console.log("  POST /api/answer - Simple Q&A (question + optional image URL)");
    console.log("  POST /api/tutor/ask - Ask a question");
    console.log("  GET  /api/tutor/history/:studentId - Get history");
    console.log("  POST /api/tutor/clear - Clear session");
    console.log("  POST /api/tutor/debug/words - Debug word extraction");
    console.log("\n📈 Monitoring:");
    console.log("  GET  /logs - View API logs in browser UI");
    console.log("  GET  /api/logs - Get logs as JSON");
    console.log("  POST /api/logs/clear - Clear all logs");
});