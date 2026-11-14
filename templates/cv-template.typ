#let cv = json(sys.inputs.data)

#set page(margin: 1.8cm)
#set text(size: 10.5pt)
#set par(leading: 0.8em)
#set list(spacing: 12pt)
#set block(spacing: 1.4em)
#show heading: set block(above: 1.6em, below: 1em)

#let header = cv.at("header", default: (name: "", contact: (:)))

#if header.name != "" [
  = #header.name

  #header.contact.values().join(" | ")
] else [
  = Jane Example

  Senior Software Engineer
]

#let entry-title(entry) = {
  let title = entry.name
  if "role" in entry { title += ", " + entry.role }
  if "dates" in entry { title += " (" + entry.dates + ")" }
  title
}

#let short-entry-limit = 3

#let render-entry(entry) = {
  let entry-head = [=== #entry-title(entry)]
  let items = entry.bullets
  if items.len() <= short-entry-limit {
    block(breakable: false, {
      entry-head
      for bullet in items [- #bullet.text]
    })
  } else {
    block(breakable: false, {
      entry-head
      [- #items.first().text]
    })
    for bullet in items.slice(1) [- #bullet.text]
  }
}

#let render-entries(entries) = for entry in entries {
  render-entry(entry)
}

#let experience = cv.at("experience", default: ())
#let projects = cv.at("projects", default: ())
#let skills = cv.at("skills", default: ())
#let grouped = (experience + projects).map(entry => entry.bullets.map(bullet => bullet.id)).flatten()
#let loose = cv.bullets.filter(bullet => not grouped.contains(bullet.id))

#if experience.len() > 0 [
  == Experience

  #render-entries(experience)
]

#if projects.len() > 0 [
  == Projects

  #render-entries(projects)
]

#if loose.len() > 0 [
  == Highlights

  #for bullet in loose [
    - #bullet.text
  ]
]

#if skills.len() > 0 [
  == Skills

  #for group in skills [
    - *#group.name:* #group.items.join(", ")
  ]
]
