import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const packs = {
    base: 'butterchurn-presets',
    extra: 'butterchurn-presets/lib/butterchurnPresetsExtra.min.js',
    extra2: 'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js',
    md1: 'butterchurn-presets/lib/butterchurnPresetsMD1.min.js',
};

// Convert only the pinned, installed preset packs into normal JavaScript at
// build time. Butterchurn accepts functions, avoiding eval/Function in the page.
export function presetModule(name) {
    if (!Object.hasOwn(packs, name)) throw new Error('Unknown MilkDrop preset pack.');
    function serialize(value) {
        if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
        if (!value || typeof value !== 'object') return JSON.stringify(value);
        const fields = [];
        for (const [key, entry] of Object.entries(value)) {
            if (/^(init|frame|pixel|point)_eqs_str$/.test(key)) {
                const target = key.slice(0, -4);
                const optional = target === 'pixel_eqs' || target === 'point_eqs';
                fields.push(`${JSON.stringify(target)}:${optional && !entry ? '""' : `function(a){${entry || ''}\nreturn a;}`}`);
            } else if (!Object.hasOwn(value, `${key}_str`)) fields.push(`${JSON.stringify(key)}:${serialize(entry)}`);
        }
        return `{${fields.join(',')}}`;
    }
    return `export default ${serialize(require(packs[name]).getPresets())};`;
}

export function milkdropPresets() {
    const prefix = 'virtual:milkdrop-presets/';
    return {
        name: 'milkdrop-presets',
        resolveId(id) { if (id.startsWith(prefix) && Object.hasOwn(packs, id.slice(prefix.length))) return `\0${id}`; },
        load(id) { if (id.startsWith(`\0${prefix}`)) return presetModule(id.slice(prefix.length + 1)); },
    };
}
