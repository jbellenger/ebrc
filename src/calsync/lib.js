const ical = require('ical');
const gapi = require('googleapis');
const lodash = require('lodash');

process.env.GOOGLE_APPLICATION_CREDENTIALS = require.resolve('../../calsync-f1852eac4f3c.json');

const gcal = gapi.calendar('v3');
const subject = 'jb@eastbayrowingclub.org';
const scopes = ['https://www.googleapis.com/auth/calendar'];
const calendarId = 'eastbayrowingclub.org_deokfeiv64l9014cml9ipugo2s@group.calendar.google.com';
const teamsnapIcal = 'http://ical-cdn.teamsnap.com/team_schedule/80232eb0-ca4c-012f-9990-404094ca0527.ics';

function log() {
  const args = [new Date(), ':'].concat(Array.from(arguments));
  console.log(args.join(' '));
}

const mkAuthClient = (subject, scopes) => new Promise((resolve, reject) => {
  gapi.auth.getApplicationDefault((err, authClient) => {
    if (err) {
      return reject(err);
    }
    authClient.subject = subject;

    if (authClient.createScopedRequired && authClient.createScopedRequired()) {
      authClient = authClient.createScoped(scopes);
    }

    authClient.authorize((err, result) => {
      if (err) {
        return reject(err);
      }
      return resolve(authClient);
    });
  });
});

const getGoogleEvents = (authClient) => {
  const loop = (pageToken) => new Promise((resolve, reject) => {
    const req = {
      auth: authClient,
      calendarId
    };
    if (pageToken) {
      req.pageToken = pageToken;
    }
    gcal.events.list(req, (err, result) => {
      if (err) {
        return reject(err);
      }
      const items = result.items;

      if (!result.nextPageToken) {
        return resolve(items);
      }
      resolve(
        loop(result.nextPageToken)
          .then((nextItems) => items.concat(nextItems))
      );
    });
  });

  return loop();
};

const updateEvent = (authClient, eventId, resource) => new Promise((resolve, reject) => {
  log('updating', eventId);
  const req = {
    auth: authClient,
    calendarId,
    eventId,
    sendNotifications: true,
    resource,
  };

  gcal.events.update(req, (err, result) => {
    if (err) {
      return reject(err);
    }
    return resolve(result);
  });
});

const getGoogleInstances = (authClient, event, timeMin, timeMax) => new Promise((resolve, reject) => {
  const req = {
    auth: authClient,
    calendarId,
    eventId: event.id,
  };

  if (timeMin) {
    req.timeMin = timeMin;
  }
  if (timeMax) {
    req.timeMax = timeMax;
  }

  gcal.events.instances(req, (err, result) => {
    if (err) {
      return reject(err);
    }
    return resolve(result);
  });
});

const getTeamsnapEvents = () => new Promise((resolve, reject) => {
  ical.fromURL(teamsnapIcal, {}, (err, data) => {
    if (err) {
      return reject(err);
    }
    const events = lodash.values(data).filter((e) => e.type && e.type === 'VEVENT');
    resolve(events);
  });
});

const vevent2Gcal = (event) => {
  return {
    icalUID: event.uid,
    description: event.description,
    attendees: [
      {email: 'men@eastbayrowingclub.org'},
    ],
    summary: event.summary,
    start: {
      dateTime: event.start,
    },
    end: {
      dateTime: event.end,
    },
  };
};

const updateInstances = (authClient, gevent, tevents) => {
  const tstamps = lodash.flatten(tevents.map((tevent) => ([
    new Date(Date.parse(tevent.start)),
    new Date(Date.parse(tevent.end)),
  ])));

  const tspan = [
    new Date(Math.min(...tstamps)).toISOString(),
    new Date(Math.max(...tstamps)).toISOString()
  ];

  return getGoogleInstances(authClient, gevent, tspan[0], tspan[1])
    .then((instances) => {
      const promises = instances.items.map((inst) => {
        const start = Date.parse(inst.start.dateTime);

        const tevent = tevents.find((te) => {
          // dates parsed by the ical module are Date objects that have had a
          // 'tz' property set on them.
          // This makes the time zones very confusing, as they'll get
          // toString'd to a form like
          // { 2016-04-19T05:20:00.000Z tz: 'America/Los_Angeles' }
          // This is obvious nonsense, as the 'Z' indicates a UTC time, but the
          // 'tz' property indicates something else.
          // Assume a Los_Angeles stamp and manually adjust the zone
          // This will break with DST.
          const teStamp = te.start - (-7 * 1000 * 60 * 60);
          return teStamp === start;
        });

        if (!tevent) {
          return;
        }
        const newInst = lodash.merge({}, inst, {
          description: tevent.description
        });
        if (lodash.isEqual(newInst, inst)) {
          return;
        }
        return updateEvent(authClient, inst.id, newInst);
      });

      return Promise.all(promises.filter(Boolean));
    });
};

const isDow = (dateStr, dows) => {
  const date = new Date(Date.parse(dateStr));
  const dateDow = date.getDay();
  return dows.some((dow) => dow === dateDow);
};

const sync = () => mkAuthClient(subject, scopes)
  .then((authClient) => {
    log('syncing...');
    return Promise.all([getTeamsnapEvents(), getGoogleEvents(authClient)])
      .then(([tevents, gevents]) => {
        const promises = [];

        // tue/thur
        promises.push(
          updateInstances(authClient,
            gevents.find((i) => isDow(i.start.dateTime, [2, 4])),
            tevents.filter((i) => isDow(i.start, [2, 4]))
          )
        );

        // mon/wed/fri
        promises.push(
          updateInstances(authClient,
            gevents.find((i) => isDow(i.start.dateTime, [1, 3, 5])),
            tevents.filter((i) => isDow(i.start, [1, 3, 5]))
          )
        );

        // sat
        promises.push(
          updateInstances(authClient,
            gevents.find((i) => isDow(i.start.dateTime, [6])),
            tevents.filter((i) => isDow(i.start, [6]))
          )
        );

        // JMB TODO: update races and other 1-offs
        return Promise.all(promises);
      })
  });

const syncLoop = (timeout) => {
  const inner = () => sync()
    .catch((err) => {
      console.error('sync error', err);
    })
    .then(() => {
      setTimeout(inner, timeout);
    });

  inner();
};

module.exports = {sync, syncLoop};
