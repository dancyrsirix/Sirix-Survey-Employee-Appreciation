# Sirix Employee Appreciation Survey

A small, self-hosted web app where employees evaluate the colleagues they work with, including executives. It follows the Sirix work appreciation form: 5 statements (one per category) rated 1 to 5 or N/A, plus one optional constructive comment. Everything is in English (the texts are editable in the admin). Each person can evaluate every colleague once and can skip any statement or any colleague. Answers are confidential: never shared with other employees, visible with their author to the administrator only. Once the survey is over, every employee receives a personal report of averages and comments, without names.

No npm dependencies: it runs on Node.js 22+ with the built-in SQLite database.

## What is in the box

- **Two separate surveys** (you can rename them or edit their questions in the admin):
  - `staff`: all non-operator employees, including executives.
  - `ops`: operators, supervisors, trainers and the operations manager (Yannick). A person can be in both.
- **Personal access codes** for every employee. The code opens their survey and prevents evaluating the same colleague twice. It is never stored with the answers.
- **Employee page** (`/` or `/s/CODE`): list of colleagues grouped by department and one short form per colleague, in the layout of the paper form (scale legend, category rows, 1 to 5 and N/A columns, constructive comment). Takes about a minute per colleague. Progress is kept, so people can come back later with the same code.
- **The 5 statements** (editable in the admin). Office staff and management: Reliability and follow-up, Responsiveness and communication, Availability and collaboration, People skills, Quality of work. Operations: Reliability on shift, Shift communication and handovers, Availability and collaboration, People skills, Event handling. A person who is not an operator but is evaluated in the operations survey (a manager, a technician) can be set, in the Employees tab, to always be evaluated with the office staff statements.
- **Built-in email**: send every employee their personal link, and later the "your report is available" notice, straight from the admin through any SMTP mailbox. Editable templates, per-person status, progress bar, failures listed by name. No mail merge needed.
- **Personal reports**: when you release the results, each employee sees their own report on their personal link: average per category next to the department and company averages, a "point fort", a priority to work on, and the constructive comments received. Reports can also be printed or saved as PDF from the admin.
- **Admin dashboard** (`/admin`): results by department and by person, written comments, CSV export, employee list with personal links, question editor, open/close/release each survey, sample data loader.

## Who sees what

1. Each evaluation is stored with the survey, the colleague being evaluated, the answers and the author. A separate lock table ("code X has finished colleague Y") enforces the once-per-colleague rule.
2. The administrator sees every evaluation with its author: in the Results tab (row detail and the "By evaluator" card) and in the "Export every evaluation" CSV. Evaluations submitted before 13 November 2026, when authors were not recorded, stay unattributed.
3. Employees never see who evaluated them. Their personal report only shows averages and comments in random order, and only once they have at least 3 evaluations (configurable in Settings), so that nobody can identify an evaluator by elimination.

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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_FROM_NAME`, `SMTP_REPLY_TO`, `SMTP_TLS_VERIFY` | unset | Optional. Mail settings are normally entered in the admin (Email tab); setting `SMTP_HOST` here locks them to these variables instead. `SMTP_SECURITY` is `tls` (465), `starttls` (587) or `none` (25). |
| `ALLOW_RESTART` | unset | Set to `1` to enable the "Restart the app" button in the admin (the process exits and the service manager restarts it). |

Tests: `npm test`

### Trying it with sample data

In the admin, open **Settings & demo data** and click **Load sample employees and demo responses**. You get a fictional roster of 27 people across 7 departments, with Yannick in both surveys, and a few hundred randomly generated evaluations so the Results tab has something to show. Click **Delete everything** when you are ready to load the real list.

## Deploying to your own Linux server (one command)

On a Debian or Ubuntu server where you have SSH and sudo, with a DNS name already pointing to it:

```bash
curl -fsSL https://raw.githubusercontent.com/dancyrsirix/Sirix-Survey-Employee-Appreciation/claude/anonymous-eval-app-oeiiy2/deploy/install.sh \
  | sudo DOMAIN=sondage.example.com bash
```

The script installs Node 22 if needed, clones the branch into `/opt/sirix-survey`, runs the app as a systemd service under a dedicated user with the database in `/var/lib/sirix-survey`, and installs Caddy, which obtains and renews the HTTPS certificate automatically. Without `DOMAIN=` the app is served on `http://SERVER-IP:3000` instead. If the repository is private, pass `REPO_URL=https://TOKEN@github.com/dancyrsirix/Sirix-Survey-Employee-Appreciation.git` with a GitHub token.

Re-running the same command updates the app and keeps the data. Logs: `journalctl -u sirix-survey -f`. Backup: copy `/var/lib/sirix-survey/survey.db`.

## Hosting it

The app is a single Node process with a SQLite file. Any of these works:

- **Docker**: `docker build -t sirix-survey .` then `docker run -d -p 3000:3000 -v survey-data:/data sirix-survey`
- **Railway, Render, Fly.io** or similar: deploy from this repository and attach a persistent volume mounted at the `DATA_DIR` path (`/data` with the Dockerfile). The platform gives you an https URL.
- **A company server or VM**: install Node 22, run `npm start` behind a reverse proxy (nginx, Caddy, IIS) that provides https. The app honors `X-Forwarded-Proto` for secure cookies.

Use https in production, since the access codes travel in the URL.

Back up the database by copying `data/survey.db` (stop the app first, or copy the `.db`, `.db-wal` and `.db-shm` files together).

## Loading the real employee list

In **Employees & links**, paste a table into the import box. Two formats are recognised from the header row:

1. **A directory export** (Microsoft 365 admin center user list, Entra, HR export), columns in any order:
   `Display name` (or `First name` + `Last name`), `Job Title`, `Department`, any column containing `Email`. Other columns
   (Office Location, ...) are ignored. People whose department is `Operators` go to the `ops` survey, everyone else
   (including `Operation`) to `staff`. Add a `Survey` column to decide yourself.
2. **The simple list**:

```
Name, Department, Role, Email, Survey
Jane Doe, Sales, Account Executive, jane@example.com, staff
John Smith, Operations, Operator, john@example.com, ops
Yannick, Operations, Operations Manager, yannick@example.com, staff+ops
```

`Survey` is `staff`, `ops` or `staff+ops`. Comma, semicolon or tab separated (copying from Excel works). Tick "Replace
the whole list" to clear the sample data first. Afterwards, edit anyone individually, for instance to put a manager in
both surveys.

## Sharing the survey with employees

Each employee gets a **personal link** of the form `https://your-domain/s/XXXXXXXXXX`, or the **general link** `https://your-domain/` plus their 10 character code.

1. In the **Email** tab, fill in the mail server (any SMTP mailbox: cPanel, Microsoft 365, Google Workspace...) and send yourself a test email. Adjust the invitation text if you like; `{first_name}`, `{name}`, `{link}`, `{code}` and `{organization}` are replaced for each person.
2. Click **Send personal links**. Emails go out one by one; the progress and any failures (wrong address, mailbox full...) are shown, and "Employees & links" shows who has received their link. Use the "not emailed yet" selection to send to newcomers, and "people who have not started" for a reminder.
3. Alternatives: **Download all links (CSV)** for a mail merge, the "copy link" / "Email link" buttons next to each name, or print the codes and hand them out with the general link.
4. When the survey period is over, set each survey to **Closed** in **Surveys & questions**. Nobody can submit after that, and you can still view and export results.

If someone loses their code, click **New code** next to their name and send them the new link. Their previous evaluations stay in place.

## Sending each employee their report

1. When the evaluation period is over, go to **Individual reports** and click **Close the survey**. Nobody can submit anymore.
2. Read the comments in **Results** first. They are shown to the person exactly as written.
3. Click **Release reports to employees**. From then on, each employee who opens their personal link (the same link they used for the survey) sees a "Voir mon rapport" button and only their own report. People with fewer evaluations than the minimum see a message instead of a report.
4. In the **Email** tab, click **Send report notices**: only people who actually have a report (enough evaluations, survey released) are emailed. Employees can print it or save it as PDF from the page.

Alternative: **Open all reports (print / PDF)** shows every report on its own page, ready to print or save as PDF, and the **Preview** link next to each name opens a single report. You can then attach the PDF to an email yourself.

A survey set to "released" stays closed for submissions. You can hide the reports again by setting it back to closed.
