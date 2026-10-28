/**
 * analysis — built-in skill: attribute statistics computed in the page from the bridge's feature stream, plus the
 * recipes the model needs to run QGIS processing correctly. Shows how a skill composes several QGIS tools.
 */
function numberStats(values) {
  const n = values.length;
  if (!n) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { count: n, min: sorted[0], max: sorted[n - 1], sum, mean, median: sorted[Math.floor(n / 2)], stddev: Math.sqrt(variance) };
}

export default {
  name: 'Analysis',
  description: 'Statistics and geoprocessing recipes',
  instructions: `## Analysis
- Quick numbers: layer_statistics(layer, fields?) returns count / min / max / mean / median / stddev for numeric fields and the most frequent values for text fields, read straight from the layer (sampled above 5000 features).
- Geoprocessing runs through QGIS processing: call processing_describe(algorithm) once to see parameter names, then processing_run with add_to_project true so results become layers. Common ids: native:buffer (INPUT, DISTANCE in layer units, SEGMENTS, DISSOLVE), native:clip (INPUT, OVERLAY), native:intersection, native:dissolve (FIELD), native:centroids, native:extractbyexpression (INPUT, EXPRESSION), native:joinattributestable, native:fieldcalculator (FIELD_NAME, FORMULA), native:reprojectlayer (TARGET_CRS), native:countpointsinpolygon.
- Layers in EPSG:4326 have degree units: reproject (native:reprojectlayer to a metric CRS such as EPSG:3857 or a local UTM) before buffering by metres.
- Selections: layer_select with a QGIS expression; layer_features(selected: true) to read them. Mention counts in the answer and keep temporary result layers clearly named.`,
  commands: [
    { name: 'stats', description: 'Statistics of a layer', prompt: 'Compute attribute statistics for this layer and summarise what stands out: ' },
    { name: 'buffer', description: 'Buffer a layer', prompt: 'Buffer this layer (check its CRS units first, reproject if needed) and add the result: ' },
  ],
  suggestions: ['Statistics of the Countries layer', 'Buffer the selected features by 50 km'],
  tools: [
    {
      name: 'layer_statistics',
      description: 'Attribute statistics of a vector layer: for numeric fields count/min/max/sum/mean/median/stddev, for text fields the number of distinct values and the five most frequent ones. Optionally restricted to given fields or a filter expression. Samples at most 5000 features.',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: 'Layer id or name' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Fields to analyse (default: all)' },
          expression: { type: 'string', description: 'QGIS filter expression (optional)' },
          selected: { type: 'boolean', description: 'Only selected features' },
        },
        required: ['layer'],
      },
      async run({ layer, fields, expression, selected }, ctx) {
        const fieldInfo = await ctx.call('layer_fields', { layer });
        const all = Array.isArray(fieldInfo) ? fieldInfo : fieldInfo.fields || [];
        const wanted = fields && fields.length ? all.filter((f) => fields.includes(f.name)) : all;
        const fc = await ctx.call('layer_features', { layer, limit: 5000, geometry: false, ...(expression ? { expression } : {}), ...(selected ? { selected: true } : {}) });
        const features = fc.features || [];
        const result = { layer, features: features.length, sampled: features.length >= 5000, fields: {} };
        for (const f of wanted) {
          const values = features.map((ft) => ft.properties ? ft.properties[f.name] : undefined).filter((v) => v !== null && v !== undefined && v !== '');
          const type = String(f.type || f.typeName || '').toLowerCase();
          const numeric = values.length && values.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))));
          if (numeric && !/string|text|date/.test(type)) result.fields[f.name] = { type: 'number', ...numberStats(values.map(Number)), nulls: features.length - values.length };
          else {
            const counts = new Map();
            for (const v of values) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
            result.fields[f.name] = { type: 'text', distinct: counts.size, nulls: features.length - values.length, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count })) };
          }
        }
        return result;
      },
    },
  ],
};
