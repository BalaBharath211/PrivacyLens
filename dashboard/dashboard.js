// dashboard.js
import {
  getAllItems,
  OBJECT_STORE_REQUESTS,
  OBJECT_STORE_TRACKERS,
  OBJECT_STORE_DOMAINS
} from '../storage/indexedDB.js';


document.addEventListener("DOMContentLoaded", async () => {
  try {
    // Defensive check to ensure D3 is loaded
    if (typeof d3 === 'undefined') {
        throw new Error('D3.js library not loaded. Please ensure d3.v7.min.js is present and included in dashboard.html before this script.');
    }

    const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
    const allTrackers = await getAllItems(OBJECT_STORE_TRACKERS);
    const allDomains = await getAllItems(OBJECT_STORE_DOMAINS);

    // --- METRIC UPDATES ---
    // 1. Change the main metric to "Total Trackers Detected"
    document.getElementById("totalTrackersHeader").textContent = "Total Trackers Detected";
    document.getElementById("totalTrackers").textContent = allRequests.length;

    // 2. Add a new metric for "Total Trackers Blocked"
    const blockedRequests = allRequests.filter(req => req.blocked).length;
    document.getElementById("totalTrackersBlocked").textContent = blockedRequests;

    // 3. Update the other metrics
    document.getElementById("uniqueTrackers").textContent = allTrackers.length;
    document.getElementById("uniqueDomains").textContent = allDomains.length;


    // --- Create "Trackers Blocked Over Time" Chart (Chart.js) ---
    const ctxTime = document.getElementById('trackersOverTimeChart').getContext('2d');
    createTrackersOverTimeChart(ctxTime, allRequests);

    // --- Create "Top Trackers" Chart (Chart.js) ---
    const ctxTop = document.getElementById('topTrackersChart').getContext('2d');
    createTopTrackersChart(ctxTop, allRequests, allTrackers);

    // --- Create D3.js Visualizations ---
    createNetworkGraph(allRequests, allTrackers, allDomains);
    createTimeline(allRequests);


  } catch (error) {
    console.error("Error loading dashboard data:", error);
    document.querySelector('.container').innerHTML = `<p style="color: red;">Error loading dashboard data: ${error.message}</p>`;
  }
});

function createTrackersOverTimeChart(ctx, allRequests) {
    const dailyCounts = {};
    allRequests.forEach(request => {
      const date = new Date(request.timestamp).toLocaleDateString();
      dailyCounts[date] = (dailyCounts[date] || 0) + 1;
    });
    const sortedDates = Object.keys(dailyCounts).sort((a, b) => new Date(a) - new Date(b));
    const dataPoints = sortedDates.map(date => dailyCounts[date]);

    new Chart(ctx, {
      type: 'line',
      data: {
        labels: sortedDates,
        datasets: [{
          label: 'Trackers Detected',
          data: dataPoints,
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1
        }]
      },
      options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
}

function createTopTrackersChart(ctx, allRequests, allTrackers) {
    const trackerNames = {};
    allTrackers.forEach(tracker => {
        trackerNames[tracker.id] = tracker.name;
    });
    const trackerCounts = {};
    allRequests.forEach(request => {
        const trackerName = trackerNames[request.trackerId] || 'Unknown Tracker';
        trackerCounts[trackerName] = (trackerCounts[trackerName] || 0) + 1;
    });
    const sortedTrackerCounts = Object.entries(trackerCounts)
        .sort(([,a],[,b]) => b - a)
        .slice(0, 5);

    const topTrackerLabels = sortedTrackerCounts.map(item => item[0]);
    const topTrackerData = sortedTrackerCounts.map(item => item[1]);

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: topTrackerLabels,
            datasets: [{
                label: 'Detection Count',
                data: topTrackerData,
                backgroundColor: ['rgba(255, 99, 132, 0.6)', 'rgba(54, 162, 235, 0.6)', 'rgba(255, 206, 86, 0.6)', 'rgba(75, 192, 192, 0.6)', 'rgba(153, 102, 255, 0.6)'],
                borderColor: ['rgba(255, 99, 132, 1)', 'rgba(54, 162, 235, 1)', 'rgba(255, 206, 86, 1)', 'rgba(75, 192, 192, 1)', 'rgba(153, 102, 255, 1)'],
                borderWidth: 1
            }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
}


// --- D3.js Visualization Functions ---
function createNetworkGraph(requests, trackers, domains) {
    const trackerMap = new Map(trackers.map(t => [t.id, { ...t, type: 'tracker' }]));
    const domainMap = new Map(domains.map(d => [d.id, { ...d, type: 'domain' }]));

    const nodeMap = new Map();
    requests.forEach(req => {
        const tracker = trackerMap.get(req.trackerId);
        const domain = domainMap.get(req.initiatorDomainId);
        if (tracker && domain) {

            // Handle unknown domains gracefully
            const domainName =
                !domain.name || domain.name === 'unknown-initiator-domain'
                ? '(Unknown Domain)'
                : domain.name;

            // Add tracker node (red)
            if (!nodeMap.has(tracker.id)) {
                nodeMap.set(tracker.id, {
                    id: tracker.id,
                    name: tracker.name,
                    type: 'tracker'
                });
            }

            // Add domain node (blue)
            if (!nodeMap.has(domain.id)) {
                nodeMap.set(domain.id, {
                    id: domain.id,
                    name: domainName,
                    type: 'domain'
                });
            }
        }

    });

    const nodes = Array.from(nodeMap.values());
    const linkSet = new Set();
    const links = [];
    requests.forEach(req => {
        const linkKey = `${req.initiatorDomainId}-${req.trackerId}`;
        if (!linkSet.has(linkKey) && nodeMap.has(req.initiatorDomainId) && nodeMap.has(req.trackerId)) {
            links.push({ source: req.initiatorDomainId, target: req.trackerId });
            linkSet.add(linkKey);
        }
    });

    const svgElement = document.getElementById('networkGraph');
    if (nodes.length < 2) {
        svgElement.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#555">Not enough data for a network graph. Browse a few more sites!</text>`;
        svgElement.setAttribute('height', '50');
        return;
    }

    const width = svgElement.parentElement.clientWidth;
    const height = 500;
    const svg = d3.select("#networkGraph").attr("viewBox", [0, 0, width, height]);

    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(60))
        .force("charge", d3.forceManyBody().strength(-150))
        .force("center", d3.forceCenter(width / 2, height / 2));

    const tooltip = d3.select("body").append("div").attr("class", "graph-tooltip");

    const link = svg.append("g").attr("class", "links").selectAll("line").data(links).join("line");

    const node = svg.append("g").attr("class", "nodes").selectAll("g").data(nodes).join("g").call(drag(simulation));
    node.append("circle").attr("r", d => d.type === 'tracker' ? 6 : 9).attr("fill", d => d.type === 'tracker' ? "#e74c3c" : "#3498db");
    node.append("text").text(d => d.name).attr('x', 12).attr('y', 4).attr("class", "node-label");

    node.on("mouseover", (event, d) => {
        tooltip.transition().duration(200).style("opacity", .9);
        tooltip.html(`<strong>${d.type.charAt(0).toUpperCase() + d.type.slice(1)}:</strong><br/>${d.name}`)
            .style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
    }).on("mouseout", () => tooltip.transition().duration(500).style("opacity", 0));

    simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    function drag(simulation) {
      function dragstarted(event) { if (!event.active) simulation.alphaTarget(0.3).restart(); event.subject.fx = event.subject.x; event.subject.fy = event.subject.y; }
      function dragged(event) { event.subject.fx = event.x; event.subject.fy = event.y; }
      function dragended(event) { if (!event.active) simulation.alphaTarget(0); event.subject.fx = null; event.subject.fy = null; }
      return d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended);
    }
}

function createTimeline(requests) {
    const svgElement = document.getElementById('timelineChart');
    if (requests.length === 0) {
        svgElement.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#555">No tracking data to display.</text>`;
        svgElement.setAttribute('height', '50');
        return;
    }

    const margin = { top: 20, right: 30, bottom: 40, left: 40 };
    const width = svgElement.parentElement.clientWidth - margin.left - margin.right;
    const height = 150 - margin.top - margin.bottom;

    const countsByDay = d3.rollup(requests, v => v.length, d => d3.timeDay.floor(new Date(d.timestamp)));
    const data = Array.from(countsByDay, ([key, value]) => ({ date: key, count: value })).sort((a,b) => a.date - b.date);

    const svg = d3.select("#timelineChart")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleTime().domain(d3.extent(data, d => d.date)).range([0, width]);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => d.count)]).range([height, 0]);

    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(width / 80).tickSizeOuter(0));
    svg.append("g").call(d3.axisLeft(y).ticks(3));

    svg.append("path").datum(data).attr("fill", "none").attr("stroke", "#75bbfd").attr("stroke-width", 2)
        .attr("d", d3.line().x(d => x(d.date)).y(d => y(d.count)));
    
    svg.append("path").datum(data).attr("fill", "rgba(117, 187, 253, 0.2)")
        .attr("d", d3.area().x(d => x(d.date)).y0(height).y1(d => y(d.count)));

    const brush = d3.brushX().extent([[0, 0], [width, height]]).on("end", brushed);
    svg.append("g").attr("class", "brush").call(brush);

    function brushed({selection}) {
        if (selection) {
            const [x0, x1] = selection.map(x.invert);
            console.log("Selected time range:", x0.toLocaleDateString(), "to", x1.toLocaleDateString());
        }
    }
}

console.log("Requests:", await getAllItems("requests"));
console.log("Domains:", await getAllItems("domains"));
