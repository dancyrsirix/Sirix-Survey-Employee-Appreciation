'use strict';
// Default surveys, default questions and sample data for trying the app.
const crypto = require('node:crypto');
const db = require('./db');

const GROUPS = [
  {
    id: 'staff', sort: 1, name: 'Sondage d’appréciation du travail (employés de bureau et direction)',
    description: 'Pour tous les employés non opérateurs, incluant la direction. Évalue les collègues avec qui tu travailles et passe les autres.',
  },
  {
    id: 'ops', sort: 2, name: 'Sondage d’appréciation du travail (opérations)',
    description: 'Pour les opérateurs, superviseurs, formateurs et le responsable des opérations. Évalue les collègues avec qui tu travailles sur les quarts et passe les autres.',
  },
];

const RATING_SCALE = 'Échelle de 1 (pas du tout d’accord) à 5 (tout à fait d’accord). Coche N/A si tu ne peux pas évaluer.';

// Five statements, one per category, plus one optional constructive comment. Same set for both surveys; editable in the admin.
const FIVE_QUESTIONS = [
  { type: 'rating', category: 'Fiabilité et suivis', text: 'Cette personne respecte ses engagements et fait les suivis nécessaires sans qu’on ait à la relancer.' },
  { type: 'rating', category: 'Réactivité et communication', text: 'Cette personne répond dans un délai raisonnable et communique de façon claire et précise.' },
  { type: 'rating', category: 'Disponibilité et collaboration', text: 'Cette personne est disponible quand j’ai besoin d’elle et collabore bien avec les autres.' },
  { type: 'rating', category: 'Côté humain', text: 'Cette personne est respectueuse, agréable à côtoyer et ouverte aux autres points de vue.' },
  { type: 'rating', category: 'Qualité du travail', text: 'Je peux me fier à la qualité du travail de cette personne.' },
  { type: 'text', category: '', text: 'Commentaire constructif pour cette personne' },
];
const QUESTIONS = { staff: FIVE_QUESTIONS, ops: FIVE_QUESTIONS };

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
  'Toujours prêt(e) à aider, même quand c’est occupé. Continue comme ça.',
  'Très clair(e) dans les réunions et les courriels.',
  'Pourrait partager ses mises à jour un peu plus tôt pour que les autres puissent planifier.',
  'Connaît les systèmes sur le bout des doigts et explique avec patience.',
  'Prend parfois trop de choses en charge; déléguer davantage aiderait.',
  'Fiable : quand c’est promis, c’est fait.',
  'Gagnerait à documenter ses processus pour les autres.',
  'Pourrait impliquer l’équipe plus tôt dans les décisions.',
  'Bonne attitude, apporte de l’énergie à l’équipe.',
  'Pourrait être plus ouvert(e) aux commentaires sur sa façon de faire.',
];

function ensureDefaults() {
  for (const g of GROUPS) if (!db.getGroup(g.id)) db.upsertGroup({ ...g, status: 'open' });
  for (const g of GROUPS) if (db.listQuestions(g.id).length === 0) db.replaceQuestions(g.id, QUESTIONS[g.id]);
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

module.exports = { GROUPS, QUESTIONS, FIVE_QUESTIONS, RATING_SCALE, SAMPLE_EMPLOYEES, ensureDefaults, restoreDefaultQuestions, loadSampleEmployees, loadDemoResponses };
