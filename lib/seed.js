'use strict';
// Default surveys, default questions and sample data for trying the app.
const crypto = require('node:crypto');
const db = require('./db');

const GROUPS = [
  {
    id: 'staff', sort: 1, name: 'Work Appreciation Survey (office staff and management)',
    description: 'For all non-operator employees, including management. Evaluate the colleagues you work with and skip the others.',
  },
  {
    id: 'ops', sort: 2, name: 'Work Appreciation Survey (operations)',
    description: 'For operators, supervisors, trainers and the operations manager. Evaluate the colleagues you work with on your shifts and skip the others.',
  },
];

const RATING_SCALE = 'Scale from 1 (strongly disagree) to 5 (strongly agree). Tick N/A if you cannot evaluate.';

// Five statements, one per category, plus one optional constructive comment. Same set for both surveys; editable in the admin.
const FIVE_QUESTIONS = [
  { type: 'rating', category: 'Reliability and follow-up', text: 'This person keeps their commitments and follows up without having to be reminded.' },
  { type: 'rating', category: 'Responsiveness and communication', text: 'This person responds within a reasonable time and communicates clearly and precisely.' },
  { type: 'rating', category: 'Availability and collaboration', text: 'This person is available when I need them and works well with others.' },
  { type: 'rating', category: 'People skills', text: 'This person is respectful, pleasant to work with and open to other points of view.' },
  { type: 'rating', category: 'Quality of work', text: 'I can rely on the quality of this person’s work.' },
  { type: 'text', category: '', text: 'Constructive comment for this person' },
];

// The first version of the app seeded these French texts. ensureDefaults() swaps them for the English
// ones above when a database still holds them untouched (question ids, and therefore answers, are kept).
const LEGACY_FR = {
  groups: {
    staff: 'Sondage d’appréciation du travail (employés de bureau et direction)',
    ops: 'Sondage d’appréciation du travail (opérations)',
  },
  descriptions: {
    staff: 'Pour tous les employés non opérateurs, incluant la direction. Évalue les collègues avec qui tu travailles et passe les autres.',
    ops: 'Pour les opérateurs, superviseurs, formateurs et le responsable des opérations. Évalue les collègues avec qui tu travailles sur les quarts et passe les autres.',
  },
  questions: [
    'Cette personne respecte ses engagements et fait les suivis nécessaires sans qu’on ait à la relancer.',
    'Cette personne répond dans un délai raisonnable et communique de façon claire et précise.',
    'Cette personne est disponible quand j’ai besoin d’elle et collabore bien avec les autres.',
    'Cette personne est respectueuse, agréable à côtoyer et ouverte aux autres points de vue.',
    'Je peux me fier à la qualité du travail de cette personne.',
    'Commentaire constructif pour cette personne',
  ],
};
// Operators work in shifts and handle events and alarms, so their survey asks about that reality.
// "Availability and collaboration" and "People skills" apply to everyone and are kept.
const OPS_QUESTIONS = [
  { type: 'rating', category: 'Reliability on shift', text: 'This person is on time, ready at the start of their shift and can be counted on until the end of it.' },
  { type: 'rating', category: 'Shift communication and handovers', text: 'This person gives clear and complete handovers and keeps the team informed of what is going on during the shift.' },
  { type: 'rating', category: 'Availability and collaboration', text: 'This person helps out when the shift gets busy and shares the workload with the team.' },
  { type: 'rating', category: 'People skills', text: 'This person is respectful, pleasant to work with and open to other points of view.' },
  { type: 'rating', category: 'Event handling', text: 'This person handles events and alarms calmly and by the procedure, even when several come in at once.' },
  { type: 'text', category: '', text: 'Constructive comment for this person' },
];
const QUESTIONS = { staff: FIVE_QUESTIONS, ops: OPS_QUESTIONS };

// Fictional sample roster. Groups: staff = non-operator survey, ops = operations survey.
const SAMPLE_EMPLOYEES = [
  ['Alex Morgan', 'Executive', 'President', ['staff']],
  ['Jordan Lee', 'Executive', 'VP Operations', ['staff']],
  ['Taylor Brooks', 'Executive', 'VP Sales', ['staff']],
  ['Samira Haddad', 'Sales', 'Account Executive', ['staff']],
  ['Marc Tremblay', 'Sales', 'Account Executive', ['staff']],
  ['Priya Nair', 'Sales', 'Sales Coordinator', ['staff']],
  ['Olivia Chen', 'Finance & Admin', 'Controller', ['staff']],
  ['Lucas Bergeron', 'Finance & Admin', 'Accounts Receivable', ['staff']],
  ['Noah Fortin', 'Finance & Admin', 'Office Administrator', ['staff']],
  ['Emma Gagnon', 'Human Resources', 'HR Manager', ['staff']],
  ['Liam Patel', 'IT', 'IT Manager', ['staff']],
  ['Sofia Rossi', 'IT', 'Systems Technician', ['staff']],
  ['Ethan Wright', 'IT', 'Integration Specialist', ['staff']],
  ['Chloe Lavoie', 'Customer Service', 'Customer Service Lead', ['staff']],
  ['Mia Desjardins', 'Customer Service', 'Customer Service Agent', ['staff']],
  ['Yannick', 'Operations', 'Operations Manager', ['staff', 'ops']],
  ['Gabriel Côté', 'Operations', 'Supervisor', ['ops']],
  ['Isabelle Roy', 'Operations', 'Supervisor', ['ops']],
  ['Hugo Lemieux', 'Operations', 'Trainer', ['ops']],
  ['Zoe Martin', 'Operations', 'Operator', ['ops']],
  ['Nathan Pelletier', 'Operations', 'Operator', ['ops']],
  ['Lea Bouchard', 'Operations', 'Operator', ['ops']],
  ['Adam Girard', 'Operations', 'Operator', ['ops']],
  ['Camille Dubois', 'Operations', 'Operator', ['ops']],
  ['Felix Lapointe', 'Operations', 'Operator', ['ops']],
  ['Jade Simard', 'Operations', 'Operator', ['ops']],
  ['William Beaulieu', 'Operations', 'Operator', ['ops']],
];

const DEMO_COMMENTS = [
  'Always ready to help, even when it is busy. Keep it up.',
  'Very clear in meetings and emails.',
  'Could share updates a bit earlier so others can plan.',
  'Knows the systems inside out and explains patiently.',
  'Sometimes takes on too much; delegating more would help.',
  'Reliable: when it is promised, it gets done.',
  'Would benefit from documenting processes for others.',
  'Could involve the team earlier in decisions.',
  'Great attitude, brings energy to the team.',
  'Could be more open to feedback on their way of doing things.',
];

function ensureDefaults() {
  for (const g of GROUPS) if (!db.getGroup(g.id)) db.upsertGroup({ ...g, status: 'open' });
  for (const g of GROUPS) if (db.listQuestions(g.id).length === 0) db.replaceQuestions(g.id, QUESTIONS[g.id]);
  // Translate untouched French defaults left by the first version.
  for (const g of GROUPS) {
    const cur = db.getGroup(g.id);
    if (cur && cur.name === LEGACY_FR.groups[g.id]) {
      db.updateGroup(g.id, { name: g.name, description: cur.description === LEGACY_FR.descriptions[g.id] ? g.description : cur.description });
    }
    const qs = db.listQuestions(g.id);
    if (qs.length === LEGACY_FR.questions.length && qs.every((q, i) => q.text === LEGACY_FR.questions[i])) {
      db.replaceQuestions(g.id, qs.map((q, i) => ({ id: q.id, ...FIVE_QUESTIONS[i] })));
    }
  }
  // Earlier versions gave the operations survey the generic office set. If it is still untouched and
  // nobody has answered it yet, switch it to the operator-specific set (new ids; nothing to preserve).
  const ops = db.listQuestions('ops');
  if (ops.length === FIVE_QUESTIONS.length && ops.every((q, i) => q.text === FIVE_QUESTIONS[i].text && q.category === FIVE_QUESTIONS[i].category)) {
    const answered = db.db.prepare(`SELECT COUNT(*) AS c FROM answers WHERE question_id IN (${ops.map(() => '?').join(',')})`).get(...ops.map(q => q.id)).c;
    if (answered === 0) db.replaceQuestions('ops', OPS_QUESTIONS);
  }
}
function restoreDefaultQuestions(groupId) {
  return db.replaceQuestions(groupId, QUESTIONS[groupId] || FIVE_QUESTIONS);
}

function loadSampleEmployees() {
  db.resetAll();
  SAMPLE_EMPLOYEES.forEach(([name, department, role, groups], i) => {
    db.createEmployee({ name, department, role, email: '', groups, sort: i });
  });
}

function loadDemoResponses() {
  // Generates plausible random evaluations: about 65% of possible pairs, with some skipped questions.
  db.resetResponses();
  const employees = db.listEmployees();
  const quality = new Map(employees.map(e => [e.id, 3.2 + Math.random() * 1.5])); // latent "how appreciated" score
  for (const g of db.listGroups()) {
    const members = employees.filter(e => e.groups.includes(g.id));
    const questions = db.listQuestions(g.id);
    for (const evaluator of members) {
      for (const target of members) {
        if (evaluator.id === target.id || Math.random() > 0.65) continue;
        const answers = {};
        const base = quality.get(target.id);
        for (const q of questions) {
          if (q.type === 'rating') {
            if (Math.random() < 0.12) continue; // skipped question
            const v = Math.round(base + (Math.random() - 0.5) * 2.2);
            answers[q.id] = Math.max(1, Math.min(5, v));
          } else {
            if (Math.random() < 0.5) continue;
            answers[q.id] = DEMO_COMMENTS[crypto.randomInt(DEMO_COMMENTS.length)];
          }
        }
        db.submitEvaluation(evaluator, g.id, target.id, answers);
      }
    }
  }
}

module.exports = { GROUPS, QUESTIONS, FIVE_QUESTIONS, OPS_QUESTIONS, RATING_SCALE, SAMPLE_EMPLOYEES, ensureDefaults, restoreDefaultQuestions, loadSampleEmployees, loadDemoResponses };
