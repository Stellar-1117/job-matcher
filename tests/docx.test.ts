import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { makeDocxFromBody } from './fixtures';
import { applyEdits, classifyParagraphs, DocxError, readParagraphs, renderParagraphs } from '../src/main/resume/docx';

const SZ = '<w:sz w:val="24"/><w:szCs w:val="24"/>';
const plainRun = (t: string) => `<w:r><w:rPr>${SZ}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const boldRun = (t: string) => `<w:r w:rsidRPr="00B32538"><w:rPr><w:b/><w:bCs/>${SZ}</w:rPr><w:t>${t}</w:t></w:r>`;
const LIST_PPR = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr><w:spacing w:after="50"/></w:pPr>';
const para = (inner: string) => `<w:p w14:paraId="1A">${inner}</w:p>`;
const bullet = (inner: string) => para(`${LIST_PPR}${inner}`);

const ROLES = { roles: [{ title: 'Senior Software Engineer', company: 'Atlassian', start: '2023', end: 'present', summary: null }] };

const BODY = [
  /* 0 */ para(plainRun('Brian Nguyen')),
  /* 1 */ para(plainRun('SKILLS')),
  /* 2 */ para(boldRun('Languages :') + plainRun(' Java, Kotlin &amp; Go')),
  /* 3 */ para(plainRun('EDUCATION')),
  /* 4 */ para(plainRun('B.S. Computer Science, a long enough line that it would count as long text if this were an experience section at all')),
  /* 5 */ para(plainRun('EXPERIENCE')),
  /* 6 */ para(`${plainRun('Senior Software Engineer | Atlassian')}<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>${plainRun('Apr 2023 – Present')}`),
  /* 7 */ bullet(`${plainRun('Built the ')}${boldRun('LLM gateway')}${plainRun(' behind Rovo. Pulled SDKs out of ')}<w:proofErr w:type="spellStart"/>${boldRun('~30 services')}<w:proofErr w:type="spellEnd"/>${plainRun('.')}`),
  /* 8 */ bullet(plainRun('Worked with the Atlassian Intelligence team on routing.')),
  /* 9 */ bullet(plainRun('Ran the migration from 2019 - 2021 across every team.')),
  /* 10 */ bullet(`<w:hyperlink r:id="rId1">${plainRun('A linked project')}</w:hyperlink>`),
  /* 11 */ bullet(`${plainRun('Mixed fonts ')}<w:r><w:rPr><w:color w:val="FF0000"/>${SZ}</w:rPr><w:t>in red</w:t></w:r>`),
  /* 12 */ para(plainRun('Short role note')),
  /* 13 */ bullet(plainRun('Owned the plain bullet with no bold in it at all.')),
  /* 14 */ para(plainRun('PUBLICATIONS')),
  /* 15 */ bullet(plainRun('A paper about something, under a heading we can not edit.')),
].join('');

const STYLES = '<styles>keep me</styles>';
const makeResume = () => makeDocxFromBody(BODY, { 'word/styles.xml': STYLES });
const documentXml = async (docx: Uint8Array) => (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
const editableIds = async (docx: Uint8Array) => new Set(classifyParagraphs(await readParagraphs(docx), ROLES).filter((p) => p.editable).map((p) => p.id));

describe('reading and classifying', () => {
  it('reads text with bold markers, sections and list items', async () => {
    const ps = await readParagraphs(await makeResume());
    expect(ps[2]).toMatchObject({ section: 'skills', text: '**Languages :** Java, Kotlin & Go', isList: false, rewritable: true });
    expect(ps[7]).toMatchObject({ section: 'experience', isList: true, rewritable: true, text: 'Built the **LLM gateway** behind Rovo. Pulled SDKs out of **~30 services**.' });
    expect(ps[5]).toMatchObject({ isHeading: true, section: 'experience' });
    expect(ps[6].rewritable).toBe(false); // tab
    expect(ps[10].rewritable).toBe(false); // hyperlink
    expect(ps[11].rewritable).toBe(false); // red run
  });

  it('keeps spaces at the edge of bold outside the markers', async () => {
    const docx = await makeDocxFromBody(para(`${plainRun('a')}<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> bold </w:t></w:r>${plainRun('b')}`));
    expect((await readParagraphs(docx))[0].text).toBe('a **bold** b');
  });

  it('only allows experience bullets and skills, and locks everything unrecognized', async () => {
    expect([...(await editableIds(await makeResume()))].sort((a, b) => a - b)).toEqual([2, 7, 13]);
  });

  it('recognizes title-case headings by style or name', async () => {
    const heading = (t: string) => para(`<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${plainRun(t)}`);
    const docx = await makeDocxFromBody([heading('Highlights'), bullet(plainRun('Locked highlight bullet')), heading('Technical Skills'), bullet(plainRun('Go, Kafka')), heading('Experience'), bullet(plainRun('Editable bullet')), heading('Education '), bullet(plainRun('Locked'))].join(''));
    expect([...(await editableIds(docx))]).toEqual([3, 5]);
  });

  it('fails clearly when nothing can be edited', async () => {
    const docx = await makeDocxFromBody(para(plainRun('Just a name')) + para(plainRun('EDUCATION')) + bullet(plainRun('A degree')));
    expect(() => classifyParagraphs([], ROLES)).toThrow(DocxError);
    await expect(readParagraphs(docx).then((ps) => classifyParagraphs(ps, ROLES))).rejects.toThrow(/Nothing in this resume can be tailored/);
  });

  it('refuses a file that is not a Word document', async () => {
    await expect(readParagraphs(new TextEncoder().encode('nope'))).rejects.toThrow(DocxError);
  });

  it('marks locked paragraphs for the prompt', async () => {
    const docx = await makeResume();
    const text = renderParagraphs(classifyParagraphs(await readParagraphs(docx), ROLES));
    expect(text).toContain('[locked] Brian Nguyen');
    expect(text).toContain('[7, max 77 chars] Built the **LLM gateway**');
    expect(text).toContain('[locked] Worked with the Atlassian');
  });
});

describe('applying edits', () => {
  it('keeps every other zip entry and every locked paragraph byte-identical', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 7, text: 'Built the **LLM gateway** for Rovo. Pulled SDKs from **~30 services**.' }], await editableIds(docx));
    expect(res.changes).toHaveLength(1);

    const [before, after] = await Promise.all([JSZip.loadAsync(docx), JSZip.loadAsync(res.docx)]);
    expect(Object.keys(after.files)).toEqual(Object.keys(before.files));
    for (const name of Object.keys(before.files)) {
      if (name === 'word/document.xml' || before.files[name].dir) continue;
      expect(await after.file(name)!.async('string')).toBe(await before.file(name)!.async('string'));
    }
    const [xmlBefore, xmlAfter] = await Promise.all([documentXml(docx), documentXml(res.docx)]);
    const edited = bullet(`${plainRun('Built the ')}${boldRun('LLM gateway')}${plainRun(' behind Rovo. Pulled SDKs out of ')}<w:proofErr w:type="spellStart"/>${boldRun('~30 services')}<w:proofErr w:type="spellEnd"/>${plainRun('.')}`);
    const [head, tail] = xmlBefore.split(edited);
    expect(xmlAfter.startsWith(head)).toBe(true);
    expect(xmlAfter.endsWith(tail)).toBe(true);
  });

  it('keeps paragraph properties and rebuilds bold from the paragraph own run properties', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 7, text: 'Built the **LLM gateway** for Rovo & <friends>.' }], await editableIds(docx));
    const xml = await documentXml(res.docx);
    expect(xml).toContain(
      `<w:p w14:paraId="1A">${LIST_PPR}<w:r><w:rPr>${SZ}</w:rPr><w:t xml:space="preserve">Built the </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/>${SZ}</w:rPr><w:t xml:space="preserve">LLM gateway</w:t></w:r><w:r><w:rPr>${SZ}</w:rPr><w:t xml:space="preserve"> for Rovo &amp; &lt;friends&gt;.</w:t></w:r></w:p>`,
    );
    expect((await readParagraphs(res.docx))[7].text).toBe('Built the **LLM gateway** for Rovo & <friends>.');
  });

  it('adds bold to a paragraph that had none by cloning its plain properties', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 13, text: 'Owned the **plain bullet** with no bold in it.' }], await editableIds(docx));
    expect(await documentXml(res.docx)).toContain(`<w:r><w:rPr><w:b/><w:bCs/>${SZ}</w:rPr><w:t xml:space="preserve">plain bullet</w:t></w:r>`);
  });

  it('derives plain text from a paragraph that was entirely bold', async () => {
    const body = para(plainRun('SKILLS')) + para(boldRun('Go and Kafka and Redis'));
    const docx = await makeDocxFromBody(body);
    const res = await applyEdits(docx, [{ id: 1, text: 'Go, **Kafka** and Redis' }], await editableIds(docx));
    expect(await documentXml(res.docx)).toContain(`<w:r><w:rPr>${SZ}</w:rPr><w:t xml:space="preserve">Go, </w:t></w:r>`);
  });

  it('drops edits to locked or unknown paragraphs, too-long, empty or unbalanced text, and duplicates', async () => {
    const docx = await makeResume();
    const res = await applyEdits(
      docx,
      [
        { id: 0, text: 'Someone Else' }, // name
        { id: 6, text: 'Principal Engineer | Atlassian' }, // role line
        { id: 8, text: 'Worked with a different team.' }, // names the company
        { id: 999, text: 'Unknown' },
        { id: 13, text: 'x'.repeat(200) }, // more than 25% longer
        { id: 2, text: '   ' },
        { id: 2, text: 'Languages : **Java' }, // duplicate, and unbalanced
        { id: 7, text: 'Built the **LLM gateway**.' },
        { id: 7, text: 'A second edit of the same paragraph.' },
      ],
      await editableIds(docx),
    );
    expect(res.changes.map((c) => c.id)).toEqual([7]);
    expect(res.dropped).toBe(8);
    expect(res.refusals).toContain('13: too long (200 chars, was 49)');
    expect(res.refusals).toContain('0: locked or unknown');
    expect(res.refusals).toContain('2: empty');
    expect(res.refusals).toContain('7: duplicate');
    const after = await readParagraphs(res.docx);
    expect(after[0].text).toBe('Brian Nguyen');
    expect(after[2].text).toBe('**Languages :** Java, Kotlin & Go');
  });

  it('refuses text whose bold markers do not pair up', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 13, text: 'Owned the **plain bullet.' }], await editableIds(docx));
    expect(res).toMatchObject({ changes: [], dropped: 1, refusals: ['13: unbalanced bold markers'] });
  });

  it('refuses a number the paragraph did not have, but not names with digits', async () => {
    const body = para(plainRun('EXPERIENCE')) + bullet(plainRun('Cut p99 latency by ~35% across 12 teams on S3, serving $1,200 a day.'));
    const docx = await makeDocxFromBody(body);
    const ids = await editableIds(docx);
    const invented = await applyEdits(docx, [{ id: 1, text: 'Cut p99 latency by ~40% across 12 teams on S3, serving $1,200 a day.' }], ids);
    expect(invented).toMatchObject({ changes: [], refusals: ['1: new number 40'] });
    const fine = await applyEdits(docx, [{ id: 1, text: 'Serving $1,200 a day on S3 and EC2, cut p95 and p99 latency ~35% for 12 teams.' }], ids);
    expect(fine).toMatchObject({ dropped: 0 });
    expect(fine.changes).toHaveLength(1);
  });

  it('returns the original bytes when nothing changed', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 2, text: '**Languages :** Java, Kotlin & Go' }], await editableIds(docx));
    expect(res).toMatchObject({ changes: [], dropped: 0, refusals: [] });
    expect(res.docx).toBe(docx);
  });

  it('removes characters XML cannot hold and line breaks', async () => {
    const docx = await makeResume();
    const res = await applyEdits(docx, [{ id: 13, text: 'Owned the\nplain \u0007bullet.' }], await editableIds(docx));
    expect((await readParagraphs(res.docx))[13].text).toBe('Owned the plain bullet.');
  });
});
