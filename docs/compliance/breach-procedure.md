# Personal data breach procedure (Art. 33, 34)

A breach is a loss of confidentiality, integrity or availability of personal data: a stolen database or backup, a leaked `.env`, an account taken over, a share link sent to the wrong person in bulk, a bug that showed one user's records to another, a provider's incident.

1. **Contain** (at once). End the access: rotate `SESSION_SECRET` (ends every session), set new passwords with the CLI, revoke share links, take the instance offline if needed. Operational steps are in SECURITY.md, Operational response.
2. **Record** (same day). Date and time found, who found it, what is affected (which accounts, which data, how many), how it happened, what was done. Keep the log: a breach is documented even when it is not reported (Art. 33(5)).
3. **Assess the risk to the people.** Is it likely to result in a risk to their rights and freedoms? Health data usually means yes. Data that was encrypted with a key the intruder did not get is not a risk to them (Art. 34(3)(a)); today's records are not encrypted on the host.
4. **Notify the supervisory authority within 72 hours** of becoming aware, unless unlikely to result in risk: ANSPDCP in Romania, via its online form, saying what happened, the categories and number of people and records, the contact, the likely consequences and the measures. Late notice says why.
5. **Tell the people concerned without undue delay** when the risk is high: in plain words, what happened, what data, what we did, what they should do (change the password, watch for messages), whom to ask. The processor (hosting, model, email provider) tells us without delay and we tell them if it is ours.
6. **Fix and learn.** Fix the cause with a test that fails without the fix, add it to the known gaps in SECURITY.md, and publish an advisory if the software has the flaw for others (SECURITY.md, Reporting a vulnerability).
