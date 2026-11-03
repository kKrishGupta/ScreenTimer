# DigitalPulse product contract

Updated: 2026-11-03

## Product boundary

DigitalPulse provides authorized employee application and website activity intelligence. It is not an HR, payroll, attendance, or employee productivity-scoring system. Activity is collected as metadata by an enrolled Windows agent and browser extension, persisted by the backend, and displayed through role-scoped dashboards.

## Identity and authorization

- The authenticated session supplies organization identity; request filters cannot select another tenant.
- Organization administrators can view their organization's authorized records and manage organization settings.
- Managers can view themselves and employees directly assigned to them. A manager's department membership does not by itself grant access to the whole department.
- Employees can view only their own assigned activity and devices.
- Collectors authenticate with device credentials and cannot choose their tenant at ingestion time.
- Enrollment tokens are single-use and time-limited. Only their hash is persisted for newly issued tokens.

## Activity semantics

- Application and website records describe collector sessions with timestamps and durations.
- Website records contain domain-level metadata; page paths, query strings, form contents, credentials, keystrokes, and clipboard contents are outside the collection contract.
- Browser foreground duration and desktop application duration are separate measures. They must not be added together as total computer active time because intervals may overlap.
- Idle time requires actual idle-state events. A running foreground process is not evidence of user activity.
- Blocked attempts are policy events and are not successful website visits or usage duration.
- A missing comparison period is represented as unavailable (`null`), not as a fabricated percentage.
- No single productivity score is emitted while app and website category durations overlap; category totals remain separate measurements.

## Data and failure behavior

- Analytics are tenant-scoped PostgreSQL queries. Missing database availability is an error state, not a zero-data result.
- Empty query results produce zero counts/durations and no fabricated activity rows.
- Productivity categories are organization-specific persisted overrides. Unclassified targets are neutral; that default does not imply an observed productivity judgment.
- Task checkboxes are user-entered planning state and are not attributed to applications or websites without an explicit, auditable task-tracking contract.
- A goal or work schedule without persistent configuration is unavailable; the dashboard must not substitute sample tasks, goals, fixed schedules, or proportional usage estimates.
- Activity session timestamps are UTC. Date filters use inclusive start dates and exclusive next-day end bounds.
- Dashboard collectors use authenticated APIs; they do not connect directly to employee devices.

## Monitoring and transparency

- Monitoring must be authorized and visibly disclosed to employees.
- Screenshots and live viewing are disabled by default and are outside the default metadata collection contract.
- Employees must be able to identify enrollment and synchronization state and request device revocation through authorized administration.

## Verification boundary

The existence of routes, UI components, agent source, migrations, or unit tests does not establish an operational workflow. Product completion requires persisted activity from an enrolled collector, authorization checks against real records, visible dashboard results, and demonstrated offline recovery and revocation behavior.
