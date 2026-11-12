'use strict';
// Default surveys, default questions and sample data for trying the app.
const crypto = require('node:crypto');
const db = require('./db');

const GROUPS = [
  {
    id: 'staff', sort: 1, name: 'Team appreciation survey (non-operator staff)',
    description: 'For all non-operator employees, including executives. Evaluate the colleagues you work with and skip the ones you do not.',
  },
  {
    id: 'ops', sort: 2, name: 'Operations appreciation survey (operators, supervisors, trainers)',
    description: 'For operators, supervisors, trainers and the operations manager. Evaluate the colleagues you work with on shift and skip the ones you do not.',
  },
];

const RATING_SCALE = 'Rate from 1 (strongly disagree) to 5 (strongly agree), or leave blank if you cannot judge.';

const QUESTIONS = {
  staff: [
    { type: 'rating', text: 'Collaboration: this colleague works well with others and is easy to work with.' },
    { type: 'rating', text: 'Communication: this colleague communicates clearly and keeps people informed.' },
    { type: 'rating', text: 'Reliability: this colleague follows through on commitments and respects deadlines.' },
    { type: 'rating', text: 'Quality: this colleague delivers accurate, high quality work.' },
    { type: 'rating', text: 'Attitude: this colleague is positive, respectful and professional.' },
    { type: 'rating', text: 'Helpfulness: this colleague helps others and shares knowledge.' },
    { type: 'rating', text: 'Overall: I appreciate working with this colleague.' },
    { type: 'text', text: 'What do you appreciate most about this colleague?' },
    { type: 'text', text: 'What is one thing this colleague could do to be even better?' },
  ],
  ops: [
    { type: 'rating', text: 'Teamwork: this colleague supports the team during the shift.' },
    { type: 'rating', text: 'Communication: this colleague communicates clearly during incidents and handovers.' },
    { type: 'rating', text: 'Procedures: this colleague follows procedures and protocols.' },
    { type: 'rating', text: 'Under pressure: this colleague stays calm and effective when things get busy.' },
    { type: 'rating', text: 'Reliability: this colleague is punctual and dependable.' },
    { type: 'rating', text: 'Helpfulness: this colleague helps others and shares what they know.' },
    { type: 'rating', text: 'Overall: I appreciate working with this colleague.' },
    { type: 'text', text: 'What do you appreciate most about this colleague?' },
    { type: 'text', text: 'What is one thing this colleague could do to be even better?' },
  ],
};

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

const POSITIVE_COMMENTS = [
  'Always willing to help, even when busy.',
  'Very clear in meetings and emails.',
  'Calm under pressure and reassuring for the rest of the team.',
  'Knows the systems inside out and explains them patiently.',
  'Reliable: if they say it will be done, it gets done.',
  'Great attitude, brings energy to the team.',
  'Takes ownership of problems instead of passing them along.',
  'Good listener and respectful with everyone.',
];
const IMPROVE_COMMENTS = [
  'Could share updates a little earlier so others can plan.',
  'Sometimes takes on too much; delegating more would help.',
  'Would benefit from documenting processes for others.',
  'Could be more open to feedback on their approach.',
  'Shorter emails would make the key point easier to find.',
  'Could involve the team earlier in decisions.',
  '',
  '',
];

function ensureDefaults() {
  for (const g of GROUPS) if (!db.getGroup(g.id)) db.upsertGroup({ ...g, status: 'open' });
  for (const g of GROUPS) if (db.listQuestions(g.id).length === 0) db.replaceQuestions(g.id, QUESTIONS[g.id]);
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
            if (Math.random() < 0.45) continue;
            const pool = /better/i.test(q.text) ? IMPROVE_COMMENTS : POSITIVE_COMMENTS;
            answers[q.id] = pool[crypto.randomInt(pool.length)];
          }
        }
        db.submitEvaluation(evaluator, g.id, target.id, answers);
      }
    }
  }
}

module.exports = { GROUPS, QUESTIONS, RATING_SCALE, SAMPLE_EMPLOYEES, ensureDefaults, loadSampleEmployees, loadDemoResponses };
