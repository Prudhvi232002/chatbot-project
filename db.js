import dotenv from 'dotenv';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultPath = path.join(__dirname, 'data.sqlite');
const DB_PATH = process.env.DB_PATH || defaultPath;

// Ensure directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

let db = null;
let SQL = null;

// Initialize sql.js
async function initializeDatabase() {
  SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      student_id TEXT PRIMARY KEY,
      previous_question TEXT,
      current_topic TEXT,
      question_count INTEGER DEFAULT 0,
      base_question_id INTEGER DEFAULT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      question TEXT,
      response TEXT,
      is_new_topic INTEGER DEFAULT 0,
      question_count INTEGER DEFAULT 0,
      timestamp TEXT
    )
  `);

  // NEW: Table for storing extracted keywords
  db.run(`
    CREATE TABLE IF NOT EXISTS question_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      question_text TEXT,
      keywords TEXT,
      matched_keywords TEXT,
      keyword_overlap_percent REAL,
      topic_decision TEXT,
      timestamp TEXT
    )
  `);

  saveDatabase();
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

export function getSession(studentId) {
  if (!db) return { previousQuestion: null, currentTopic: null, questionCount: 0, baseQuestionId: null };
  
  const result = db.exec('SELECT * FROM sessions WHERE student_id = ?', [studentId]);
  
  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0];
    return {
      previousQuestion: row[1],
      currentTopic: row[2],
      questionCount: row[3],
      baseQuestionId: row[4] || null,
    };
  }

  // Create a new session row
  db.run('INSERT OR IGNORE INTO sessions (student_id, previous_question, current_topic, question_count, base_question_id) VALUES (?, NULL, NULL, 0, NULL)', [studentId]);
  saveDatabase();
  return { previousQuestion: null, currentTopic: null, questionCount: 0, baseQuestionId: null };
}

// ⭐ NEW: Update the base question ID when a NEW TOPIC is detected
export function updateBaseQuestionId(studentId, newBaseQuestionId) {
  if (!db) return;
  
  db.run(
    'UPDATE sessions SET base_question_id = ? WHERE student_id = ?',
    [newBaseQuestionId, studentId]
  );
  saveDatabase();
}

// ⭐ NEW: Restore previous base question when a NEW TOPIC question is deleted
export function restorePreviousBaseQuestion(studentId) {
  if (!db) return false;
  
  try {
    // Get all questions BEFORE the last one (excluding the deleted one)
    const result = db.exec(
      `SELECT id, topic_decision FROM question_keywords 
       WHERE student_id = ? 
       ORDER BY id DESC LIMIT 2`,
      [studentId]
    );
    
    if (result.length === 0 || result[0].values.length < 2) {
      // Not enough questions to restore to
      return false;
    }
    
    // Get the second-to-last question (the one before the deleted one)
    const previousQuestionId = result[0].values[1][0];
    const previousTopicDecision = result[0].values[1][1];
    
    // If the previous question was NEW TOPIC, use it as base
    if (previousTopicDecision === 'NEW TOPIC') {
      updateBaseQuestionId(studentId, previousQuestionId);
      console.log(`[BASE RESTORE] ✅ Restored base to previous NEW TOPIC question (ID: ${previousQuestionId})`);
      return true;
    } else {
      // Keep searching backwards for a NEW TOPIC question
      const allQuestions = db.exec(
        `SELECT id, topic_decision FROM question_keywords 
         WHERE student_id = ? 
         ORDER BY id DESC`,
        [studentId]
      );
      
      if (allQuestions.length > 0 && allQuestions[0].values.length > 0) {
        for (const question of allQuestions[0].values) {
          if (question[1] === 'NEW TOPIC') {
            updateBaseQuestionId(studentId, question[0]);
            console.log(`[BASE RESTORE] ✅ Restored base to earlier NEW TOPIC question (ID: ${question[0]})`);
            return true;
          }
        }
      }
    }
    
    return false;
  } catch (error) {
    console.error(`[BASE RESTORE] ❌ Error restoring base:`, error);
    return false;
  }
}

// ⭐ NEW: Get the base question with keywords
export function getBaseQuestion(studentId) {
  if (!db) return null;
  
  const session = getSession(studentId);
  if (!session.baseQuestionId) return null;
  
  const result = db.exec(
    'SELECT id, question_text, keywords FROM question_keywords WHERE student_id = ? AND id = ? LIMIT 1',
    [studentId, session.baseQuestionId]
  );
  
  if (result.length === 0 || result[0].values.length === 0) return null;
  
  const row = result[0].values[0];
  return {
    id: row[0],
    question: row[1],
    keywords: row[2].split('|').filter(k => k.trim())
  };
}

export function upsertSession(studentId, { previousQuestion, currentTopic, questionCount }) {
  if (!db) return;
  
  db.run(`
    INSERT INTO sessions (student_id, previous_question, current_topic, question_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      previous_question = excluded.previous_question,
      current_topic = excluded.current_topic,
      question_count = excluded.question_count
  `, [studentId, previousQuestion, currentTopic, questionCount]);
  
  saveDatabase();
}

export function addMessage(studentId, { question, response, isNewTopic, questionCount, timestamp }) {
  if (!db) return;
  
  db.run(`
    INSERT INTO messages (student_id, question, response, is_new_topic, question_count, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [studentId, question, response, isNewTopic ? 1 : 0, questionCount ?? 0, timestamp ?? new Date().toISOString()]);
  
  saveDatabase();
}

export function getHistory(studentId) {
  if (!db) return [];
  
  const result = db.exec('SELECT question, response, is_new_topic AS isNewTopic, question_count AS questionCount, timestamp FROM messages WHERE student_id = ? ORDER BY id ASC', [studentId]);
  
  if (result.length === 0) return [];
  
  return result[0].values.map(row => ({
    question: row[0],
    response: row[1],
    isNewTopic: row[2],
    questionCount: row[3],
    timestamp: row[4]
  }));
}

export function clearSession(studentId) {
  if (!db) return;
  
  db.run('DELETE FROM messages WHERE student_id = ?', [studentId]);
  db.run('DELETE FROM sessions WHERE student_id = ?', [studentId]);
  db.run('DELETE FROM question_keywords WHERE student_id = ?', [studentId]);
  
  saveDatabase();
}

// NEW: Save keywords for a question
export function saveQuestionKeywords(studentId, questionText, keywords, matchedKeywords = [], overlapPercent = 0, topicDecision = 'NEW TOPIC') {
  if (!db) return;
  
  const keywordString = keywords.join('|'); // Store as pipe-separated string
  const matchedKeywordsString = matchedKeywords.join('|');
  const timestamp = new Date().toISOString();
  
  db.run(`
    INSERT INTO question_keywords (student_id, question_id, question_text, keywords, matched_keywords, keyword_overlap_percent, topic_decision, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [studentId, Date.now(), questionText, keywordString, matchedKeywordsString, overlapPercent, topicDecision, timestamp]);
  
  saveDatabase();
  
  // ✅ DISPLAY SAVED DATA IN TERMINAL
  console.log(`\n📊 [DATABASE SAVED]`);
  console.log(`   Student: ${studentId}`);
  console.log(`   Question: "${questionText}"`);
  console.log(`   Keywords: [${keywords.join(', ')}]`);
  console.log(`   Matched Keywords: [${matchedKeywords.length > 0 ? matchedKeywords.join(', ') : 'none'}]`);
  console.log(`   Keyword Overlap: ${overlapPercent.toFixed(1)}%`);
  console.log(`   Topic Decision: ${topicDecision}`);
  console.log(`   Timestamp: ${timestamp}`);
  console.log(`   ✅ Saved to database\n`);
}

// ⭐ NEW: Delete the last question for a student (used when editing)
export function deleteLastQuestion(studentId) {
  if (!db) return false;
  
  try {
    // Get the last question ID
    const result = db.exec(
      'SELECT id FROM question_keywords WHERE student_id = ? ORDER BY id DESC LIMIT 1',
      [studentId]
    );
    
    if (result.length === 0 || result[0].values.length === 0) {
      console.log(`[EDIT DELETE] No questions to delete for student: ${studentId}`);
      return false;
    }
    
    const lastQuestionId = result[0].values[0][0];
    
    // Delete it
    db.run('DELETE FROM question_keywords WHERE id = ? AND student_id = ?', [lastQuestionId, studentId]);
    saveDatabase();
    
    console.log(`[EDIT DELETE] ✅ Deleted last question (ID: ${lastQuestionId}) for student: ${studentId}`);
    
    // ⭐ NEW: If the deleted question was a NEW TOPIC, restore previous base
    restorePreviousBaseQuestion(studentId);
    
    return true;
  } catch (error) {
    console.error(`[EDIT DELETE] ❌ Error deleting question:`, error);
    return false;
  }
}

// NEW: Get all previous questions with their keywords
export function getPreviousQuestionsWithKeywords(studentId) {
  if (!db) return [];
  
  const result = db.exec(
    'SELECT id, question_id, question_text, keywords, matched_keywords, keyword_overlap_percent, topic_decision, timestamp FROM question_keywords WHERE student_id = ? ORDER BY id ASC',
    [studentId]
  );
  
  if (result.length === 0) return [];
  
  return result[0].values.map(row => ({
    id: row[0],
    question_id: row[1],
    question: row[2],
    keywords: row[3].split('|').filter(k => k.trim()), // Parse pipe-separated keywords
    matchedKeywords: row[4] ? row[4].split('|').filter(k => k.trim()) : [],
    keywordOverlapPercent: row[5],
    topicDecision: row[6],
    timestamp: row[7]
  }));
}

// NEW: Calculate keyword overlap between current and previous questions
export function compareKeywordOverlapDB(currentKeywords, previousQuestionsWithKeywords) {
  if (previousQuestionsWithKeywords.length === 0) {
    return {
      isNewTopic: true,
      analysis: []
    };
  }

  const analysis = [];
  let maxOverlap = 0;

  for (const prevQ of previousQuestionsWithKeywords) {
    const prevKeywordsSet = new Set(prevQ.keywords);
    const currentKeywordsSet = new Set(currentKeywords);
    
    // Calculate intersection
    const matching = [...currentKeywordsSet].filter(k => prevKeywordsSet.has(k));
    const overlapPercent = (matching.length / currentKeywordsSet.size) * 100;
    
    analysis.push({
      question: prevQ.question,
      matchingKeywords: matching,
      overlapPercent: overlapPercent.toFixed(1),
      prevKeywords: prevQ.keywords
    });

    maxOverlap = Math.max(maxOverlap, overlapPercent);
  }

  return {
    isNewTopic: maxOverlap < 65, // Require 65% overlap to be same topic
    analysis: analysis,
    maxOverlapPercent: maxOverlap.toFixed(1)
  };
}

export default db;

// ✅ NEW: Display all saved keywords in database
export function displayDatabaseContents(studentId = null) {
  if (!db) return;
  
  const query = studentId 
    ? 'SELECT * FROM question_keywords WHERE student_id = ? ORDER BY id DESC'
    : 'SELECT * FROM question_keywords ORDER BY id DESC';
  
  const result = db.exec(query, studentId ? [studentId] : []);
  
  if (result.length === 0 || result[0].values.length === 0) {
    console.log(`\n📭 [DATABASE EMPTY] No keywords saved yet\n`);
    return;
  }
  
  console.log(`\n📋 [DATABASE CONTENTS] ${studentId ? `(Student: ${studentId})` : '(All Students)'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  result[0].values.forEach((row, idx) => {
    const [id, sid, qid, qtext, keywords, matchedKeywords, overlapPercent, topicDecision, timestamp] = row;
    console.log(`\n${idx + 1}. [ID: ${id}]`);
    console.log(`   Student: ${sid}`);
    console.log(`   Question: "${qtext}"`);
    console.log(`   Keywords: [${keywords.replace(/\|/g, ', ')}]`);
    console.log(`   Matched: [${matchedKeywords ? matchedKeywords.replace(/\|/g, ', ') : 'none'}]`);
    console.log(`   Overlap: ${overlapPercent !== null ? overlapPercent.toFixed(1) + '%' : 'N/A'}`);
    console.log(`   Decision: ${topicDecision || 'N/A'}`);
    console.log(`   Saved: ${timestamp}`);
  });
  
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// Initialize database on import
await initializeDatabase();
