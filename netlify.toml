# QuickBooks sync (estimates, invoices, bills, payments): every 5 minutes
[functions."qb-sync-hourly"]
  schedule = "*/5 * * * *"

[functions."nightly-backup"]
  schedule = "0 7 * * *"

# Sunday nights: Monday 01:00 UTC = Sunday 8 PM Eastern (9 PM during daylight time)
[functions."weekly-ready-to-pay"]
  schedule = "0 1 * * 1"

# Mondays 13:53 UTC = 8:53 AM Eastern (9:53 during daylight time): last week's daily-report summary to Slack
[functions."weekly-report-summary"]
  schedule = "53 13 * * 1"
