export function buildSectionPaths({sections,posts,projects}) {
  const paths=[];
  for (const section of sections.filter(section=>section.enabled && section.path !== '/')) {
    const path=section.path.slice(1);
    if (section.layout === '普通页面') {
      paths.push({params:{path},props:{view:'page',section}});
      continue;
    }
    const collection=section.layout === '项目网格'?projects:posts;
    const items=collection.filter(item=>item.data.moduleKey === section.key);
    paths.push({params:{path},props:{view:section.layout === '项目网格'?'projects':'archive',section,items}});
    for (const item of items) paths.push({params:{path:`${path}/${item.id}`},props:{view:section.layout === '项目网格'?'project':'article',section,item,items}});
  }
  return paths;
}
