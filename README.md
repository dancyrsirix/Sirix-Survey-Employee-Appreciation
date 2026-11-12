# Sirix Employee Appreciation Survey

A small, self-hosted web app where employees anonymously evaluate the colleagues they work with, including executives. Each person can evaluate every colleague once, can skip any question or any colleague, and nobody (not even the administrator) can see who wrote what.

No npm dependencies: it runs on Node.js 22+ with the built-in SQLite database.

## What is in the box

- **Two separate surveys** (you can rename them or edit their questions in the admin):
  - `staff`: all non-operator employees, including executives.
  - `ops`: operators, supervisors, trainers and the operations manager (Yannick). A person can be in both.
- **Personal access codes** for every employee. The code opens their survey and prevents evaluating the same colleague twice. It is never stored with the answers.
- **Employee page** (`/` or `/s/CODE`): list of colleagues grouped by department, one short form per colleague, 1 to 5 ratings plus two free text questions. Every question is optional. Progress is kept, so people can come back later with the same code.
- **Admin dashboard** (`/admin`): results by department and by person, written comments, CSV export, employee list with personal links, question editor, open/close each survey, sample data loader.

## How anonymity works

1. When someone submits an evaluation, the server writes two separate records:
   - a lock saying "code X has finished colleague Y" (so the same pair cannot be submitted again), and
   - the answers, stored with only the survey and the colleague being evaluated. No evaluator id, no timestamp, no IP address, and a random id instead of a sequential one, so there is no order to correlate against the lock table.
2. Results for a person are hidden until they have at least 3 evaluations (configurable in Settings). This prevents identifying an evaluator by elimination.
3. Written comments are shown in random order.
4. The admin sees whether each person has participated (yes/no), never whom they evaluated.

The one thing the system must know is which (evaluator, colleague) pairs are finished, otherwise the "once per colleague" rule cannot be enforced. That list is not shown anywhere in the admin and cannot be linked to any answer.

## Running it

```bash
npm start
# open http://localhost:3000        (employees)
# open http://localhost:3000/admin  (administrator)
```

The first time you open `/admin` you are asked to create the administrator username and password. Only a salted hash is stored in the database. You can change the password later under Settings.

Alternatively set the credentials with environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_USER` | `admin` | Admin username (only used together with `ADMIN_PASSWORD`) |
| `ADMIN_PASSWORD` | unset | If set, this password is used and the first-run setup is skipped |
| `DATA_DIR` | `./data` | Folder for the SQLite database. Must be on a persistent disk. |
| `SEED_SAMPLE` | unset | Set to `1` to load the sample roster and demo responses on first start (only if the database is empty) |

Tests: `npm test`

### Trying it with sample data

In the admin, open **Settings & demo data** and click **Load sample employees and demo responses**. You get a fictional roster of 27 people across 7 departments, with Yannick in both surveys, and a few hundred randomly generated evaluations so the Results tab has something to show. Click **Delete everything** when you are ready to load the real list.

## Hosting it

The app is a single Node process with a SQLite file. Any of these works:

- **Docker**: `docker build -t sirix-survey .` then `docker run -d -p 3000:3000 -v survey-data:/data sirix-survey`
- **Railway, Render, Fly.io** or similar: deploy from this repository and attach a persistent volume mounted at the `DATA_DIR` path (`/data` with the Dockerfile). The platform gives you an https URL.
- **A company server or VM**: install Node 22, run `npm start` behind a reverse proxy (nginx, Caddy, IIS) that provides https. The app honors `X-Forwarded-Proto` for secure cookies.

Use https in production, since the access codes travel in the URL.

Back up the database by copying `data/survey.db` (stop the app first, or copy the `.db`, `.db-wal` and `.db-shm` files together).

## Loading the real employee list

In **Employees & links**, paste one line per employee into the import box:

```
Name, Department, Role, Email, Survey
Jane Doe, Sales, Account Executive, jane@example.com, staff
John Smith, Operations, Operator, john@example.com, ops
Yannick, Operations, Operations Manager, yannick@example.com, staff+ops
```

`Survey` is `staff`, `ops` or `staff+ops`. Columns copied from Excel (tab separated) also work. Tick "Replace the whole list" to clear the sample data first. Email is optional; it only makes the mail merge easier.

## Sharing the survey with employees

Each employee gets a **personal link** of the form `https://your-domain/s/XXXXXXXXXX`, or the **general link** `https://your-domain/` plus their 10 character code.

1. In **Employees & links**, click **Download all links (CSV for mail merge)**. The file has Name, Department, Role, Email, Access code and Personal link.
2. Send each person their own link. Options:
   - Mail merge from Outlook (Word mail merge) or Gmail (with a Google Sheet) using the CSV.
   - Send them one by one with the "copy link" button next to each name.
   - Print the codes and hand them out, telling people to go to the general link and type their code.
3. Tell employees: the code only serves to make sure each colleague is evaluated once, answers are anonymous, every question and every colleague can be skipped, and they can come back later with the same code.
4. When the survey period is over, set each survey to **Closed** in **Surveys & questions**. Nobody can submit after that, and you can still view and export results.

If someone loses their code, click **New code** next to their name and send them the new link. Their previous evaluations stay in place.
