import _ from 'underscore';
import {EventEmitter} from 'events';
import SettingsStore from './settings-store';
import Client from './github-client';
import BipartiteGraph from './bipartite-graph';
import {getRelatedIssues} from './gfm-dom';
import {fetchAll, FETCHALL_MAX, contains, KANBAN_LABEL, UNCATEGORIZED_NAME} from './helpers';
import Card from './card-model';

const RELOAD_TIME = 30 * 1000;

const toIssueKey = (repoOwner, repoName, number) => {
  return `${repoOwner}/${repoName}#${number}`;
};

const delayedPromise = (fn) => {
  let promise = null;
  return () => {
    if (promise) {
      return promise;
    } else {
      promise = fn();
      return promise;
    }
  };
};

let CARD_CACHE = {};
const cardFactory = (repoOwner, repoName, number, issue, graph) => {
  const key = toIssueKey(repoOwner, repoName, number);
  let card = CARD_CACHE[key];
  if (card) {
    card.resetPromisesAndState(issue, graph);
    return card;
  } else {
    card = new Card(repoOwner, repoName, number, issue, graph);
    CARD_CACHE[key] = card;
    return card;
  }
}


export function filterCards(cards, labels) {
  let filtered = cards;
  // Curry the fn so it is not declared inside a loop
  const filterFn = (label) => (card) => {
    const containsLabel = contains(card.issue.labels, (cardLabel) => {
      return cardLabel.name === label.name;
    });
    if (containsLabel) {
      return true;
    } else if (UNCATEGORIZED_NAME === label.name) {
      // If the issue does not match any list then add it to the backlog
      for (const l of card.issue.labels) {
        if (KANBAN_LABEL.test(l.name)) {
          return false;
        }
      }
      // no list labels, so include it in the backlog
      return true;
    }
  };
  for (const i in labels) {
    const label = labels[i];
    filtered = _.filter(filtered, filterFn(label));
    if (filtered.length === 0) {
      return [];
    }
  }
  return filtered;
}

function _buildBipartiteGraph(graph, cards) {
  const allPullRequests = {};
  const allIssues = {};

  _.each(cards, (card) => {
    const cardPath = graph.cardToKey(card);
    if (card.issue.pullRequest) {
      // card is a Pull Request
      allPullRequests[cardPath] = card;
    } else {
      // or card is an Issue
      allIssues[cardPath] = card;
    }
  });

  _.each(cards, (card) => {
    const cardPath = graph.cardToKey(card);
    const relatedIssues = getRelatedIssues(card.issue.body, card.repoOwner, card.repoName);
    if (card.issue.pullRequest) {
      // card is a Pull Request
      _.each(relatedIssues, ({repoOwner, repoName, number, fixes}) => {
        const otherCardPath = graph.cardToKey({repoOwner, repoName, issue: {number}});
        if (allIssues[otherCardPath]) {
          graph.addEdge(otherCardPath, cardPath, allIssues[otherCardPath], card, fixes);
        }
      });
    }
  });
}

export function buildBipartiteGraph(cards) {
  const graph = new BipartiteGraph();
  _buildBipartiteGraph(graph, cards);
  return graph;
}

let cacheCardsRepoInfos = null;
let cacheCards = null;
let cacheLastViewed = {};
const initialTimestamp = new Date();

let isPollingEnabled = false;

class IssueStore extends EventEmitter {
  off() { // EventEmitter has `.on` but no matching `.off`
    const slice = [].slice;
    const args = arguments.length >= 1 ? slice.call(arguments, 0) : [];
    return this.removeListener.apply(this, args);
  }
  clearCacheCards() {
    cacheCards = null;
    cacheCardsRepoInfos = null;
    CARD_CACHE = {};
  }
  stopPolling() {
    isPollingEnabled = false;
  }
  startPolling() {
    isPollingEnabled = true;
  }
  issueNumberToCard(repoOwner, repoName, number, issue=null, graph=null, pullRequestDelayedPromise=null) {
    if (!(repoOwner && repoName && number)) {
      throw new Error('BUG! Forgot to pass arguments in');
    }
    return cardFactory(repoOwner, repoName, number, issue, graph);
  }
  issueToCard(repoOwner, repoName, issue, graph) {
    if (!(repoOwner && repoName && issue)) {
      throw new Error('BUG! Forgot to pass arguments in');
    }
    return cardFactory(repoOwner, repoName, issue.number, issue, graph);
  }
  fetchAllIssues(repoInfos, isForced) {
    // Start/keep polling
    if (!this.polling && isPollingEnabled) {
      this.polling = setTimeout(() => {
        this.polling = null;
        this.fetchAllIssues(repoInfos, true /*isForced*/);
      }, RELOAD_TIME);
    }
    if (!isForced && cacheCards && cacheCardsRepoInfos === JSON.stringify(repoInfos)) {
      return Promise.resolve(cacheCards);
    }
    const graph = new BipartiteGraph();
    const allPromises = _.map(repoInfos, ({repoOwner, repoName}) => {
      const issues = Client.getOcto().repos(repoOwner, repoName).issues.fetch;
      return fetchAll(FETCHALL_MAX, issues)
      .then((vals) => {
        return _.map(vals, (issue) => {
          // If this is a Pull Request fetch the data and the CI status.
          // Add the promise to the card
          if (issue.pullRequest && SettingsStore.getShowPullRequestData()) {
            const fn = () => {
              if (Client.getRateLimitRemaining() < Client.LOW_RATE_LIMIT) {
                return Promise.resolve({});
              }

              return Client.getOcto().repos(repoOwner, repoName).pulls(issue.number).fetch().then((pullRequest) => {
                // TODO: Check if we still have a bunch of karma before getting merge conflict status and updated dates.
                if (Client.getRateLimitRemaining() < Client.LOW_RATE_LIMIT) {
                  return {pullRequest};
                }
                return Client.getOcto().repos(repoOwner, repoName).commits(pullRequest.head.sha).statuses.fetch().then((statuses) => {
                  return {pullRequest, statuses};
                });
              });
            };
            const pullRequestDelayedPromise = delayedPromise(fn);
            return this.issueNumberToCard(repoOwner, repoName, issue.number, issue, graph);
          } else {
            return this.issueNumberToCard(repoOwner, repoName, issue.number, issue, graph);
          }
        });
      });
    });
    return Promise.all(allPromises).then((issues) => {
      const cards = _.flatten(issues, true /*shallow*/);

      CARD_CACHE = {};
      _buildBipartiteGraph(graph, cards);

      cacheCards = cards;
      cacheCardsRepoInfos = JSON.stringify(repoInfos);
      if (isForced) {
        this.emit('change');
      }
      return cards;
    });
  }
  fetchMilestones(repoOwner, repoName) {
    return Client.getOcto().repos(repoOwner, repoName).milestones.fetch();
  }
  tryToMoveLabel(card, graph, primaryRepoName, label) {
    this.emit('tryToMoveLabel', card, graph, primaryRepoName, label);
  }
  tryToMoveMilestone(card, graph, primaryRepoName, milestone) {
    this.emit('tryToMoveMilestone', card, graph, primaryRepoName, milestone);
  }
  moveLabel(repoOwner, repoName, issue, newLabel) {
    // Find all the labels, remove the kanbanLabel, and add the new label
    // Exclude Kanban labels
    const labels = _.filter(issue.labels, (label) => {
      if (UNCATEGORIZED_NAME === label.name || KANBAN_LABEL.test(label.name)) {
        return false;
      }
      return true;
    });
    const labelNames = _.map(labels);
    // When moving back to uncategorized do not add a new label
    if (UNCATEGORIZED_NAME !== newLabel.name) {
      labelNames.push(newLabel.name);
    }

    return Client.getOcto().repos(repoOwner, repoName).issues(issue.number).update({labels: labelNames})
    .then(() => {

      this.setLastViewed(repoOwner, repoName, issue.number);

      // invalidate the issues list
      cacheCards = null;
      this.emit('change');
    });
  }
  moveMilestone(repoOwner, repoName, issue, newMilestone) {
    // TODO: Check if the milestone exists. If not, create it

    Client.getOcto().repos(repoOwner, repoName).milestones.fetch()
    .then((milestones) => {
      // Find the milestone with a matching Title
      const matchingMilestone = _.filter(milestones, (milestone) => {
        return milestone.title === newMilestone.title;
      })[0];

      return Client.getOcto().repos(repoOwner, repoName).issues(issue.number).update({milestone: matchingMilestone.number})
      .then(() => {

        this.setLastViewed(repoOwner, repoName, issue.number);

        // invalidate the issues list
        cacheCards = null;
        this.emit('change');
      });

    });

  }
  createLabel(repoOwner, repoName, opts) {
    return Client.getOcto().repos(repoOwner, repoName).labels.create(opts);
  }
  setLastViewed(repoOwner, repoName, issueNumber) {
    const issueKey = toIssueKey(repoOwner, repoName, issueNumber);
    let now = new Date();
    now = new Date(now.getTime() + 5 * 1000); // Add 5 sec just in case
    const isNew = !cacheLastViewed[issueKey] || (now.getTime() - cacheLastViewed[issueKey].getTime() > 10000);
    cacheLastViewed[issueKey] = now;
    if (isNew) {
      this.emit('change:' + issueKey);
    }
  }
  getLastViewed(repoOwner, repoName, issueNumber) {
    const issueKey = toIssueKey(repoOwner, repoName, issueNumber);
    return cacheLastViewed[issueKey] || initialTimestamp;
  }
}

export default new IssueStore();
