import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  const pagesRes = await db.query("SELECT id, slug, title, type FROM pages WHERE deleted_at IS NULL");
  const linksRes = await db.query(`
    SELECT
      l.id,
      l.link_type,
      p_from.slug as from_slug,
      p_from.title as from_title,
      p_from.type as from_type,
      p_to.slug as to_slug,
      p_to.title as to_title,
      p_to.type as to_type
    FROM links l
    JOIN pages p_from ON l.from_page_id = p_from.id
    JOIN pages p_to ON l.to_page_id = p_to.id
  `);

  await db.close();

  const nodes = pagesRes.rows.map(p => ({
    data: {
      id: p.slug,
      label: p.title || p.slug,
      type: p.type || 'unknown'
    }
  }));

  const edges = linksRes.rows.map(l => ({
    data: {
      id: `edge-${l.id}`,
      source: l.from_slug,
      target: l.to_slug,
      label: l.link_type
    }
  }));

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GBrain - Semantic Graph</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.26.0/cytoscape.min.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0f1115;
      color: #e5e9f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
      display: flex;
      height: 100vh;
    }
    #cy {
      flex: 1;
      height: 100%;
    }
    #sidebar {
      width: 320px;
      background-color: #161920;
      border-left: 1px solid #232834;
      padding: 20px;
      display: flex;
      flex-direction: column;
      box-shadow: -5px 0 15px rgba(0,0,0,0.3);
      z-index: 10;
    }
    h2 {
      margin-top: 0;
      font-size: 1.2rem;
      border-bottom: 1px solid #232834;
      padding-bottom: 10px;
      color: #88c0d0;
    }
    .legend {
      margin-top: 15px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 0.85rem;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .color-box {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }
    #details {
      margin-top: 20px;
      padding: 15px;
      background-color: #1e222b;
      border-radius: 6px;
      border: 1px solid #2e3440;
      font-size: 0.9rem;
      flex-grow: 1;
      overflow-y: auto;
    }
    #details h3 {
      margin-top: 0;
      font-size: 1rem;
      color: #8fbcbb;
    }
    #search-box {
      width: 100%;
      padding: 8px;
      background-color: #1e222b;
      border: 1px solid #2e3440;
      border-radius: 4px;
      color: #e5e9f0;
      box-sizing: border-box;
      margin-bottom: 15px;
    }
    #search-box:focus {
      outline: none;
      border-color: #88c0d0;
    }
  </style>
</head>
<body>
  <div id="cy"></div>
  <div id="sidebar">
    <h2>GBrain Graph</h2>
    <input type="text" id="search-box" placeholder="Rechercher une note...">
    <div class="legend">
      <div class="legend-item"><div class="color-box" style="background-color: #88c0d0;"></div><span>Source (Livre / Article)</span></div>
      <div class="legend-item"><div class="color-box" style="background-color: #a3be8c;"></div><span>Projet</span></div>
      <div class="legend-item"><div class="color-box" style="background-color: #ebcb8b;"></div><span>Concept</span></div>
      <div class="legend-item"><div class="color-box" style="background-color: #b48ead;"></div><span>Note / Autre</span></div>
    </div>
    <div id="details">
      <h3>Détails</h3>
      <p style="color: #4c566a;">Cliquez sur un nœud pour afficher ses détails sémantiques et ses connexions.</p>
    </div>
  </div>

  <script>
    const nodes = ${JSON.stringify(nodes)};
    const edges = ${JSON.stringify(edges)};

    const cy = cytoscape({
      container: document.getElementById('cy'),
      elements: [...nodes, ...edges],
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'color': '#e5e9f0',
            'background-color': '#b48ead',
            'font-size': '11px',
            'text-valign': 'bottom',
            'text-margin-y': '6px',
            'width': '16px',
            'height': '16px',
            'transition-property': 'background-color, width, height',
            'transition-duration': '0.2s'
          }
        },
        {
          selector: 'node[type="source"]',
          style: {
            'background-color': '#88c0d0',
            'width': '22px',
            'height': '22px',
          }
        },
        {
          selector: 'node[type="project"]',
          style: {
            'background-color': '#a3be8c',
            'width': '20px',
            'height': '20px',
          }
        },
        {
          selector: 'node[type="concept"]',
          style: {
            'background-color': '#ebcb8b',
            'width': '18px',
            'height': '18px',
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 1.5,
            'line-color': '#2e3440',
            'target-arrow-color': '#2e3440',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 0.8,
            'opacity': 0.6
          }
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': '3px',
            'border-color': '#81a1c1',
            'width': '26px',
            'height': '26px'
          }
        }
      ],
      layout: {
        name: 'cose',
        idealEdgeLength: 100,
        nodeOverlap: 20,
        refresh: 20,
        fit: true,
        padding: 30,
        randomize: false,
        componentSpacing: 100,
        nodeRepulsion: 400000,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      }
    });

    cy.on('tap', 'node', function(evt){
      const node = evt.target;
      const id = node.id();
      const label = node.data('label');
      const type = node.data('type');

      const outgoing = node.outgoers().edges();
      const incoming = node.incomers().edges();

      let html = '<h3>' + label + '</h3>';
      html += '<p><strong>Slug :</strong> <code style="background-color: #2e3440; padding: 2px 4px; border-radius: 3px;">' + id + '</code></p>';
      html += '<p><strong>Type :</strong> <span style="text-transform: capitalize; color: #81a1c1;">' + type + '</span></p>';

      if (outgoing.length > 0) {
        html += '<p><strong>Références sortantes (' + outgoing.length + ') :</strong></p><ul>';
        outgoing.forEach(e => {
          html += '<li>' + e.target().data('label') + ' <span style="font-size: 0.75rem; color: #4c566a;">(' + e.data('label') + ')</span></li>';
        });
        html += '</ul>';
      }

      if (incoming.length > 0) {
        html += '<p><strong>Backlinks (' + incoming.length + ') :</strong></p><ul>';
        incoming.forEach(e => {
          html += '<li>' + e.source().data('label') + '</li>';
        });
        html += '</ul>';
      }

      document.getElementById('details').innerHTML = html;
    });

    document.getElementById('search-box').addEventListener('input', function(e) {
      const q = e.target.value.toLowerCase().trim();
      if (!q) {
        cy.elements().removeClass('highlighted');
        return;
      }

      cy.elements().forEach(el => {
        if (el.isNode() && el.data('label').toLowerCase().includes(q)) {
          el.addClass('highlighted');
          cy.animate({
            fit: {
              eles: el,
              padding: 50
            },
            duration: 300
          });
        } else {
          el.removeClass('highlighted');
        }
      });
    });
  </script>
</body>
</html>`;

  const outputDir = '/root/brain/exports';
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'graph.html'), htmlContent);
  console.log("Graph HTML visualizer successfully generated at /root/brain/exports/graph.html");
} catch (e) {
  console.error("Error generating graph visualizer:", e);
}
